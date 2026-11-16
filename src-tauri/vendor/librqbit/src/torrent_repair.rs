fn value_end(bytes: &[u8], start: usize) -> Option<usize> {
    match *bytes.get(start)? {
        b'i' => {
            let end = start + 1 + bytes.get(start + 1..)?.iter().position(|&byte| byte == b'e')?;
            Some(end + 1)
        }
        b'l' | b'd' => {
            let mut at = start + 1;
            while *bytes.get(at)? != b'e' {
                at = value_end(bytes, at)?;
            }
            Some(at + 1)
        }
        b'0'..=b'9' => {
            let colon = start + bytes.get(start..)?.iter().position(|&byte| byte == b':')?;
            let length: usize = std::str::from_utf8(&bytes[start..colon]).ok()?.parse().ok()?;
            let end = colon.checked_add(1)?.checked_add(length)?;
            (end <= bytes.len()).then_some(end)
        }
        _ => None,
    }
}

fn byte_string(bytes: &[u8], start: usize) -> Option<&[u8]> {
    let end = value_end(bytes, start)?;
    let colon = start + bytes[start..end].iter().position(|&byte| byte == b':')?;
    bytes[start].is_ascii_digit().then(|| &bytes[colon + 1..end])
}

fn is_number(value: &[u8]) -> bool {
    value.len() > 2
        && value[0] == b'i'
        && value[value.len() - 1] == b'e'
        && value[1..value.len() - 1].iter().all(u8::is_ascii_digit)
}

fn is_list_of_lists_of_strings(value: &[u8]) -> bool {
    if value.first() != Some(&b'l') {
        return false;
    }
    let mut at = 1;
    while at < value.len() - 1 {
        if value[at] != b'l' {
            return false;
        }
        let Some(end) = value_end(value, at) else {
            return false;
        };
        let mut inner = at + 1;
        while inner < end - 1 {
            if !value[inner].is_ascii_digit() {
                return false;
            }
            let Some(next) = value_end(value, inner) else {
                return false;
            };
            inner = next;
        }
        at = end;
    }
    true
}

fn fits(key: &[u8], value: &[u8]) -> bool {
    match key {
        b"info" => value.first() == Some(&b'd'),
        b"creation date" => is_number(value),
        b"announce-list" => is_list_of_lists_of_strings(value),
        b"announce" | b"comment" | b"created by" | b"encoding" | b"publisher" | b"publisher-url" => {
            value.first().is_some_and(u8::is_ascii_digit)
        }
        _ => true,
    }
}

pub fn repair_torrent_bytes(bytes: &[u8]) -> Option<Vec<u8>> {
    if bytes.first() != Some(&b'd') {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len());
    out.push(b'd');
    let mut at = 1;
    let mut dropped = false;
    let mut has_info = false;
    while *bytes.get(at)? != b'e' {
        let key = byte_string(bytes, at)?;
        let key_end = value_end(bytes, at)?;
        let value_stop = value_end(bytes, key_end)?;
        let value = &bytes[key_end..value_stop];
        if fits(key, value) {
            has_info |= key == b"info";
            out.extend_from_slice(&bytes[at..value_stop]);
        } else {
            dropped = true;
        }
        at = value_stop;
    }
    out.push(b'e');
    (dropped && has_info).then_some(out)
}
