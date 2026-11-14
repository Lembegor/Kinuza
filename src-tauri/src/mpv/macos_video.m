// mpv's picture on macOS: an OpenGL layer placed under the Tauri web view, filled through libmpv's render API.
// The layer redraws only when mpv has a new frame (an asynchronous CAOpenGLLayer would redraw on every display refresh)
// and renders on its own serial queue, because a render call waits until the frame is due.

#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#import <OpenGL/gl3.h>
#import <IOKit/pwr_mgt/IOPMLib.h>
#include <dlfcn.h>
#include <os/lock.h>
#include <mpv/client.h>
#include <mpv/render_gl.h>

static const void *const RenderQueueKey = &RenderQueueKey;

static void runOnMain(dispatch_block_t block) {
    if ([NSThread isMainThread]) {
        block();
    } else {
        dispatch_sync(dispatch_get_main_queue(), block);
    }
}

static void *glProcAddress(void *context, const char *name) {
    (void)context;
    return dlsym(RTLD_DEFAULT, name);
}

static CGLPixelFormatObj createPixelFormat(void) {
    const CGLPixelFormatAttribute profiles[] = {(CGLPixelFormatAttribute)kCGLOGLPVersion_3_2_Core, (CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy};
    for (int index = 0; index < 2; index++) {
        CGLPixelFormatAttribute attributes[] = {
            kCGLPFAOpenGLProfile, profiles[index],
            kCGLPFAAccelerated,
            kCGLPFADoubleBuffer,
            kCGLPFASupportsAutomaticGraphicsSwitching,
            0,
        };
        CGLPixelFormatObj format = NULL;
        GLint count = 0;
        if (CGLChoosePixelFormat(attributes, &format, &count) == kCGLNoError && format) {
            return format;
        }
    }
    return NULL;
}

@interface KinuzaVideoLayer : CAOpenGLLayer
- (instancetype)initWithMpv:(mpv_handle *)mpv;
- (void)scheduleRender;
- (void)shutdown;
@end

// Called from mpv's threads, where no mpv function may run: only queue the work.
static void onUpdate(void *context) {
    [(__bridge KinuzaVideoLayer *)context scheduleRender];
}

@implementation KinuzaVideoLayer {
    CGLPixelFormatObj _pixelFormat;
    CGLContextObj _context;
    mpv_render_context *_render;
    dispatch_queue_t _queue;
}

- (instancetype)initWithMpv:(mpv_handle *)mpv {
    if (!(self = [super init])) {
        return nil;
    }
    self.asynchronous = NO;
    self.needsDisplayOnBoundsChange = YES;
    self.opaque = YES;
    self.backgroundColor = NSColor.blackColor.CGColor;

    _pixelFormat = createPixelFormat();
    if (!_pixelFormat || CGLCreateContext(_pixelFormat, NULL, &_context) != kCGLNoError) {
        NSLog(@"Kinuza: no OpenGL context for the video layer");
        return nil;
    }
    GLint swapInterval = 1;
    CGLSetParameter(_context, kCGLCPSwapInterval, &swapInterval);

    CGLSetCurrentContext(_context);
    mpv_opengl_init_params gl = {.get_proc_address = glProcAddress};
    mpv_render_param params[] = {
        {MPV_RENDER_PARAM_API_TYPE, MPV_RENDER_API_TYPE_OPENGL},
        {MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, &gl},
        {MPV_RENDER_PARAM_INVALID, NULL},
    };
    int error = mpv_render_context_create(&_render, mpv, params);
    CGLSetCurrentContext(NULL);
    if (error < 0) {
        NSLog(@"Kinuza: mpv render context failed: %s", mpv_error_string(error));
        return nil;
    }

    _queue = dispatch_queue_create("kinuza.video.render", DISPATCH_QUEUE_SERIAL);
    dispatch_queue_set_specific(_queue, RenderQueueKey, (void *)RenderQueueKey, NULL);
    mpv_render_context_set_update_callback(_render, onUpdate, (__bridge void *)self);
    return self;
}

- (void)dealloc {
    if (_context) {
        CGLReleaseContext(_context);
    }
    if (_pixelFormat) {
        CGLReleasePixelFormat(_pixelFormat);
    }
}

- (CGLPixelFormatObj)copyCGLPixelFormatForDisplayMask:(uint32_t)mask {
    return CGLRetainPixelFormat(_pixelFormat);
}

- (CGLContextObj)copyCGLContextForPixelFormat:(CGLPixelFormatObj)pixelFormat {
    return CGLRetainContext(_context);
}

- (void)scheduleRender {
    dispatch_async(_queue, ^{
        [self renderIfNeeded];
    });
}

- (void)renderIfNeeded {
    @synchronized(self) {
        if (!_render || !(mpv_render_context_update(_render) & MPV_RENDER_UPDATE_FRAME)) {
            return;
        }
    }
    [CATransaction begin];
    [CATransaction setDisableActions:YES];
    [self display];
    [CATransaction commit];
    [CATransaction flush];
}

- (BOOL)canDrawInCGLContext:(CGLContextObj)context pixelFormat:(CGLPixelFormatObj)pixelFormat forLayerTime:(CFTimeInterval)time displayTime:(const CVTimeStamp *)displayTime {
    return YES;
}

- (void)drawInCGLContext:(CGLContextObj)context pixelFormat:(CGLPixelFormatObj)pixelFormat forLayerTime:(CFTimeInterval)time displayTime:(const CVTimeStamp *)displayTime {
    BOOL rendered = NO;
    @synchronized(self) {
        if (_render) {
            GLint framebuffer = 0;
            GLint viewport[4] = {0, 0, 0, 0};
            glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &framebuffer);
            glGetIntegerv(GL_VIEWPORT, viewport);
            mpv_opengl_fbo target = {.fbo = framebuffer, .w = viewport[2], .h = viewport[3]};
            int flip = 1;
            // Only the render queue waits for the frame's display time; redraws AppKit asks for (resizing) must not block the main thread.
            int block = dispatch_get_specific(RenderQueueKey) != NULL;
            mpv_render_param params[] = {
                {MPV_RENDER_PARAM_OPENGL_FBO, &target},
                {MPV_RENDER_PARAM_FLIP_Y, &flip},
                {MPV_RENDER_PARAM_BLOCK_FOR_TARGET_TIME, &block},
                {MPV_RENDER_PARAM_INVALID, NULL},
            };
            mpv_render_context_render(_render, params);
            rendered = YES;
        }
    }
    if (!rendered) {
        glClearColor(0, 0, 0, 1);
        glClear(GL_COLOR_BUFFER_BIT);
    }
    [super drawInCGLContext:context pixelFormat:pixelFormat forLayerTime:time displayTime:displayTime];
    @synchronized(self) {
        if (_render) {
            mpv_render_context_report_swap(_render);
        }
    }
}

// The render context has to go before the mpv core, with its OpenGL context current, and not while a frame is drawing.
- (void)shutdown {
    dispatch_sync(_queue, ^{
        @synchronized(self) {
            if (!self->_render) {
                return;
            }
            mpv_render_context_set_update_callback(self->_render, NULL, NULL);
            CGLSetCurrentContext(self->_context);
            mpv_render_context_free(self->_render);
            self->_render = NULL;
            CGLSetCurrentContext(NULL);
        }
    });
}

@end

@interface KinuzaVideoView : NSView
@property(nonatomic, weak) NSView *webview;
@property(nonatomic, strong) KinuzaVideoLayer *videoLayer;
@end

@implementation KinuzaVideoView

// The interface above handles every click; the picture never takes the mouse.
- (NSView *)hitTest:(NSPoint)point {
    return nil;
}

- (BOOL)acceptsFirstResponder {
    return NO;
}

- (void)setFrameSize:(NSSize)size {
    [super setFrameSize:size];
    self.videoLayer.frame = self.bounds;
}

- (void)viewDidChangeBackingProperties {
    [super viewDidChangeBackingProperties];
    self.videoLayer.contentsScale = self.window.backingScaleFactor ?: 1;
    [self.videoLayer setNeedsDisplay];
}

@end

void *kinuza_video_attach(void *webviewPointer, mpv_handle *mpv) {
    __block void *result = NULL;
    runOnMain(^{
        NSView *webview = (__bridge NSView *)webviewPointer;
        NSView *parent = webview.superview;
        if (!parent) {
            return;
        }
        KinuzaVideoLayer *layer = [[KinuzaVideoLayer alloc] initWithMpv:mpv];
        if (!layer) {
            return;
        }
        KinuzaVideoView *view = [[KinuzaVideoView alloc] initWithFrame:webview.frame];
        view.webview = webview;
        view.videoLayer = layer;
        view.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
        view.layer = layer;
        view.wantsLayer = YES;
        layer.frame = view.bounds;
        layer.contentsScale = webview.window.backingScaleFactor ?: 1;
        view.hidden = YES;
        [parent addSubview:view positioned:NSWindowBelow relativeTo:webview];
        result = (__bridge_retained void *)view;
    });
    return result;
}

// The web view stops painting its background only while the player is open: a see-through web view costs GPU time
// on every frame, even over a static page.
void kinuza_video_set_shown(void *video, bool shown) {
    KinuzaVideoView *view = (__bridge KinuzaVideoView *)video;
    dispatch_async(dispatch_get_main_queue(), ^{
        view.hidden = !shown;
        [view.webview setValue:@(!shown) forKey:@"drawsBackground"];
        if (shown) {
            [view.videoLayer setNeedsDisplay];
        }
    });
}

void kinuza_video_place(void *video, int x, int y, int width, int height) {
    KinuzaVideoView *view = (__bridge KinuzaVideoView *)video;
    dispatch_async(dispatch_get_main_queue(), ^{
        NSView *webview = view.webview;
        NSView *parent = view.superview;
        if (!webview || !parent) {
            return;
        }
        CGFloat scale = webview.window.backingScaleFactor ?: 1;
        NSRect area = webview.frame;
        CGFloat w = MAX(1, width / scale);
        CGFloat h = MAX(1, height / scale);
        CGFloat left = area.origin.x + x / scale;
        CGFloat top = parent.isFlipped ? area.origin.y + y / scale : area.origin.y + area.size.height - y / scale - h;
        view.autoresizingMask = NSViewNotSizable;
        view.frame = NSMakeRect(left, top, w, h);
    });
}

void kinuza_video_detach(void *video) {
    KinuzaVideoView *view = (__bridge_transfer KinuzaVideoView *)video;
    [view.videoLayer shutdown];
    runOnMain(^{
        [view.webview setValue:@YES forKey:@"drawsBackground"];
        [view removeFromSuperview];
    });
}

void kinuza_sleep_prevent(bool prevent) {
    static os_unfair_lock lock = OS_UNFAIR_LOCK_INIT;
    static IOPMAssertionID assertion = kIOPMNullAssertionID;
    os_unfair_lock_lock(&lock);
    if (prevent && assertion == kIOPMNullAssertionID) {
        IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleDisplaySleep, kIOPMAssertionLevelOn, CFSTR("Kinuza is playing a film"), &assertion);
    } else if (!prevent && assertion != kIOPMNullAssertionID) {
        IOPMAssertionRelease(assertion);
        assertion = kIOPMNullAssertionID;
    }
    os_unfair_lock_unlock(&lock);
}
