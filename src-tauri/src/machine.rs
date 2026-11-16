use std::process::Command;

#[cfg(unix)]
const OPEN_FILES_WANTED: [u64; 4] = [65_536, 24_576, 10_240, 4_096];

#[cfg(unix)]
pub fn raise_open_files() {
    let mut limit = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } != 0 {
        tracing::warn!("machine: could not read the open files limit");
        return;
    }
    let before = limit.rlim_cur as u64;
    let ceiling = limit.rlim_max as u64;
    for wanted in OPEN_FILES_WANTED {
        let target = wanted.min(ceiling);
        if target <= before {
            break;
        }
        let next = libc::rlimit { rlim_cur: target as libc::rlim_t, rlim_max: limit.rlim_max };
        if unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &next) } == 0 {
            tracing::info!("machine: open files limit {before} -> {target}");
            return;
        }
    }
    tracing::info!("machine: open files limit stays {before}");
}

#[cfg(not(unix))]
pub fn raise_open_files() {}

pub fn describe_in_background() {
    std::thread::spawn(|| {
        for line in describe() {
            tracing::info!("machine: {line}");
        }
    });
}

fn run(program: &str, arguments: &[&str]) -> Option<String> {
    let mut command = Command::new(program);
    command.args(arguments);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let output = command.output().ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

#[cfg(windows)]
const WINDOWS_QUERY: &str = r#"[Console]::OutputEncoding=[Text.Encoding]::UTF8
$os=Get-CimInstance Win32_OperatingSystem
"os: $($os.Caption) $($os.Version) build $($os.BuildNumber) $($os.OSArchitecture)"
$cpu=Get-CimInstance Win32_Processor | Select-Object -First 1
"cpu: $($cpu.Name.Trim()) cores=$($cpu.NumberOfCores) threads=$($cpu.NumberOfLogicalProcessors)"
"ram: $([math]::Round($os.TotalVisibleMemorySize/1MB,1)) GB, free $([math]::Round($os.FreePhysicalMemory/1MB,1)) GB"
Get-CimInstance Win32_VideoController | ForEach-Object { "gpu: $($_.Name) driver=$($_.DriverVersion) mode=$($_.CurrentHorizontalResolution)x$($_.CurrentVerticalResolution)@$($_.CurrentRefreshRate)Hz" }
Get-CimInstance Win32_DesktopMonitor | ForEach-Object { "monitor: $($_.Name) $($_.ScreenWidth)x$($_.ScreenHeight)" }
Get-CimInstance Win32_SoundDevice | ForEach-Object { "sound: $($_.Name) status=$($_.Status)" }"#;

#[cfg(windows)]
fn describe() -> Vec<String> {
    use winreg::{enums::HKEY_CURRENT_USER, enums::HKEY_LOCAL_MACHINE, RegKey};

    let mut lines: Vec<String> = run("powershell", &["-NoProfile", "-NonInteractive", "-Command", WINDOWS_QUERY])
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect();
    let scheduling = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey(r"SYSTEM\CurrentControlSet\Control\GraphicsDrivers")
        .and_then(|key| key.get_value::<u32, _>("HwSchMode"))
        .map(|mode| if mode == 2 { "on" } else { "off" })
        .unwrap_or("default");
    let directx = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\DirectX\UserGpuPreferences")
        .and_then(|key| key.get_value::<String, _>("DirectXUserGlobalSettings"))
        .unwrap_or_else(|_| "default".to_owned());
    lines.push(format!("graphics: gpu scheduling={scheduling} directx settings={directx}"));
    lines
}

#[cfg(target_os = "macos")]
fn describe() -> Vec<String> {
    let memory = run("sysctl", &["-n", "hw.memsize"]).and_then(|bytes| bytes.parse::<f64>().ok()).unwrap_or(0.0);
    vec![
        format!("os: macOS {}", run("sw_vers", &["-productVersion"]).unwrap_or_default()),
        format!("model: {}", run("sysctl", &["-n", "hw.model"]).unwrap_or_default()),
        format!("cpu: {}", run("sysctl", &["-n", "machdep.cpu.brand_string"]).unwrap_or_default()),
        format!("ram: {:.1} GB", memory / 1_073_741_824.0),
    ]
}

#[cfg(not(any(windows, target_os = "macos")))]
fn describe() -> Vec<String> {
    vec![format!("os: {}", run("uname", &["-sr"]).unwrap_or_default())]
}

const WINDOW_PING_EVERY: std::time::Duration = std::time::Duration::from_secs(1);
const WINDOW_STALL_SECONDS: u64 = 3;

pub fn watch_window_thread(app: tauri::AppHandle) {
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    };
    let started = std::time::Instant::now();
    let answered = Arc::new(AtomicU64::new(0));
    std::thread::spawn(move || {
        let mut stalled_since: Option<u64> = None;
        loop {
            std::thread::sleep(WINDOW_PING_EVERY);
            let now = started.elapsed().as_secs();
            let flag = answered.clone();
            if app.run_on_main_thread(move || flag.store(started.elapsed().as_secs(), Ordering::Relaxed)).is_err() {
                return;
            }
            let last = answered.load(Ordering::Relaxed);
            let behind = now.saturating_sub(last);
            match stalled_since {
                None if behind >= WINDOW_STALL_SECONDS && last > 0 => {
                    tracing::warn!("window: not answering for {behind}s");
                    stalled_since = Some(last);
                }
                Some(since) if behind < WINDOW_STALL_SECONDS => {
                    tracing::warn!("window: answering again after {}s", now.saturating_sub(since));
                    stalled_since = None;
                }
                _ => {}
            }
        }
    });
}
