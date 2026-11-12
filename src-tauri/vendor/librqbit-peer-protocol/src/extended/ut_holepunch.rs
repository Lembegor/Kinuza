use std::io::Write;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use byteorder::{BE, WriteBytesExt};

use crate::{DoubleBufHelper, MessageDeserializeError, SerializeError};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HolepunchKind {
    Rendezvous,
    Connect,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HolepunchError {
    NoSuchPeer,
    NotConnected,
    NoSupport,
    NoSelf,
    Unknown(u32),
}

impl HolepunchError {
    pub fn code(self) -> u32 {
        match self {
            HolepunchError::NoSuchPeer => 1,
            HolepunchError::NotConnected => 2,
            HolepunchError::NoSupport => 3,
            HolepunchError::NoSelf => 4,
            HolepunchError::Unknown(code) => code,
        }
    }

    pub fn from_code(code: u32) -> Option<Self> {
        match code {
            0 => None,
            1 => Some(HolepunchError::NoSuchPeer),
            2 => Some(HolepunchError::NotConnected),
            3 => Some(HolepunchError::NoSupport),
            4 => Some(HolepunchError::NoSelf),
            other => Some(HolepunchError::Unknown(other)),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UtHolepunch {
    pub kind: HolepunchKind,
    pub addr: SocketAddr,
    pub error: Option<HolepunchError>,
}

impl UtHolepunch {
    pub fn rendezvous(addr: SocketAddr) -> Self {
        Self { kind: HolepunchKind::Rendezvous, addr, error: None }
    }

    pub fn connect(addr: SocketAddr) -> Self {
        Self { kind: HolepunchKind::Connect, addr, error: None }
    }

    pub fn error(addr: SocketAddr, error: HolepunchError) -> Self {
        Self { kind: HolepunchKind::Error, addr, error: Some(error) }
    }

    pub fn serialize(&self, out: &mut impl Write) -> Result<(), SerializeError> {
        out.write_u8(match self.kind {
            HolepunchKind::Rendezvous => 0,
            HolepunchKind::Connect => 1,
            HolepunchKind::Error => 2,
        })?;
        match self.addr.ip() {
            IpAddr::V4(ip) => {
                out.write_u8(0)?;
                out.write_all(&ip.octets())?;
            }
            IpAddr::V6(ip) => {
                out.write_u8(1)?;
                out.write_all(&ip.octets())?;
            }
        }
        out.write_u16::<BE>(self.addr.port())?;
        out.write_u32::<BE>(self.error.map(HolepunchError::code).unwrap_or(0))?;
        Ok(())
    }

    pub fn deserialize(mut buf: DoubleBufHelper<'_>) -> Result<Self, MessageDeserializeError> {
        let not_enough = |missing| MessageDeserializeError::NotEnoughData(missing, None);
        let kind = match buf.read_u8().ok_or(not_enough(1))? {
            0 => HolepunchKind::Rendezvous,
            1 => HolepunchKind::Connect,
            2 => HolepunchKind::Error,
            other => return Err(MessageDeserializeError::UnsupportedMessageId(other)),
        };
        let ip: IpAddr = match buf.read_u8().ok_or(not_enough(1))? {
            0 => Ipv4Addr::from(buf.consume::<4>().map_err(not_enough)?).into(),
            1 => Ipv6Addr::from(buf.consume::<16>().map_err(not_enough)?).into(),
            other => return Err(MessageDeserializeError::UnsupportedMessageId(other)),
        };
        let port = u16::from_be_bytes(buf.consume::<2>().map_err(not_enough)?);
        let error = buf.read_u32_be().map_err(not_enough)?;
        if !buf.is_empty() {
            return Err(MessageDeserializeError::UtMetadataTrailingBytes);
        }
        Ok(Self {
            kind,
            addr: SocketAddr::new(ip, port),
            error: HolepunchError::from_code(error),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip(message: UtHolepunch) {
        let mut bytes = Vec::new();
        message.serialize(&mut bytes).unwrap();
        assert_eq!(UtHolepunch::deserialize(DoubleBufHelper::new(&bytes, &[])).unwrap(), message);
        for split in 0..bytes.len() {
            let (first, second) = bytes.split_at(split);
            assert_eq!(UtHolepunch::deserialize(DoubleBufHelper::new(first, second)).unwrap(), message);
        }
    }

    #[test]
    fn messages_round_trip() {
        round_trip(UtHolepunch::rendezvous("1.2.3.4:6881".parse().unwrap()));
        round_trip(UtHolepunch::connect("[2001:db8::1]:51413".parse().unwrap()));
        round_trip(UtHolepunch::error("5.6.7.8:1".parse().unwrap(), HolepunchError::NotConnected));
    }

    #[test]
    fn wire_layout_matches_bep_55() {
        let mut bytes = Vec::new();
        UtHolepunch::error("10.0.0.1:258".parse().unwrap(), HolepunchError::NoSupport).serialize(&mut bytes).unwrap();
        assert_eq!(bytes, [2, 0, 10, 0, 0, 1, 1, 2, 0, 0, 0, 3]);
    }
}
