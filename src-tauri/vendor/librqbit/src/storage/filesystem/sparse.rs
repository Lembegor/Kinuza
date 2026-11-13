#[cfg(windows)]
pub fn mark_file_sparse(f: &std::fs::File) -> bool {
    use std::os::windows::io::AsRawHandle;
    use windows::{
        Win32::Foundation::HANDLE, Win32::System::IO::DeviceIoControl,
        Win32::System::Ioctl::FSCTL_SET_SPARSE,
    };

    let handle = HANDLE(f.as_raw_handle());

    unsafe { DeviceIoControl(handle, FSCTL_SET_SPARSE, None, 0, None, 0, None, None).is_ok() }
}

#[cfg(windows)]
pub fn zero_range(f: &std::fs::File, offset: u64, len: u64) -> anyhow::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows::{
        Win32::Foundation::HANDLE, Win32::System::IO::DeviceIoControl,
        Win32::System::Ioctl::{FILE_ZERO_DATA_INFORMATION, FSCTL_SET_ZERO_DATA},
    };

    let handle = HANDLE(f.as_raw_handle());
    let info = FILE_ZERO_DATA_INFORMATION {
        FileOffset: offset as i64,
        BeyondFinalZero: (offset + len) as i64,
    };
    unsafe {
        DeviceIoControl(
            handle,
            FSCTL_SET_ZERO_DATA,
            Some(&info as *const FILE_ZERO_DATA_INFORMATION as *const core::ffi::c_void),
            std::mem::size_of::<FILE_ZERO_DATA_INFORMATION>() as u32,
            None,
            0,
            None,
            None,
        )?;
    }
    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    use std::io::{Read, Seek, SeekFrom, Write};

    #[test]
    fn a_zeroed_range_reads_back_as_zeros_and_the_rest_stays() {
        let path = std::env::temp_dir().join(format!("rqbit-sparse-{}", std::process::id()));
        let mut file = std::fs::OpenOptions::new().create(true).truncate(true).read(true).write(true).open(&path).unwrap();
        assert!(super::mark_file_sparse(&file));
        file.write_all(&vec![7u8; 3 * 1024 * 1024]).unwrap();
        super::zero_range(&file, 1024 * 1024, 1024 * 1024).unwrap();
        let mut back = Vec::new();
        file.seek(SeekFrom::Start(0)).unwrap();
        file.read_to_end(&mut back).unwrap();
        assert_eq!(back.len(), 3 * 1024 * 1024);
        assert!(back[..1024 * 1024].iter().all(|b| *b == 7));
        assert!(back[1024 * 1024..2 * 1024 * 1024].iter().all(|b| *b == 0));
        assert!(back[2 * 1024 * 1024..].iter().all(|b| *b == 7));
        drop(file);
        let _ = std::fs::remove_file(path);
    }
}
