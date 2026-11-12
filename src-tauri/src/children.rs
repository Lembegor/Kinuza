use tokio::process::{Child, Command};

#[cfg(windows)]
mod job {
    use std::sync::OnceLock;
    use windows_sys::Win32::{
        Foundation::HANDLE,
        System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
    };

    struct Job(HANDLE);
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    static JOB: OnceLock<Option<Job>> = OnceLock::new();

    fn job() -> Option<&'static Job> {
        JOB.get_or_init(|| unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return None;
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let set = SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            (set != 0).then_some(Job(handle))
        })
        .as_ref()
    }

    pub fn adopt(child: &tokio::process::Child) {
        let (Some(job), Some(process)) = (job(), child.raw_handle()) else { return };
        unsafe {
            AssignProcessToJobObject(job.0, process as HANDLE);
        }
    }
}

pub fn die_with_app(command: &mut Command) -> &mut Command {
    #[cfg(target_os = "linux")]
    unsafe {
        command.pre_exec(|| {
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
            Ok(())
        });
    }
    command
}

pub fn spawn(command: &mut Command) -> std::io::Result<Child> {
    let child = die_with_app(command).spawn()?;
    #[cfg(windows)]
    job::adopt(&child);
    Ok(child)
}
