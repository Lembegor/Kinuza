use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket},
    time::{Duration, Instant},
};

use anyhow::{anyhow, bail, Result};
use serde::Serialize;

const SSDP_ADDRESS: &str = "239.255.255.250:1900";
const SEARCH_TARGETS: &[&str] = &["urn:schemas-upnp-org:device:MediaRenderer:1", "urn:schemas-upnp-org:service:AVTransport:1"];
const SEARCH_SECONDS: u64 = 3;
const DESCRIPTION_TIMEOUT: Duration = Duration::from_secs(4);
const CONTROL_TIMEOUT: Duration = Duration::from_secs(8);
const AV_TRANSPORT: &str = "urn:schemas-upnp-org:service:AVTransport:1";
const RENDERING_CONTROL: &str = "urn:schemas-upnp-org:service:RenderingControl:1";
const CONNECTION_MANAGER: &str = "urn:schemas-upnp-org:service:ConnectionManager:1";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Renderer {
    pub id: String,
    pub name: String,
    pub maker: String,
    pub model: String,
    pub address: String,
    #[serde(skip)]
    pub transport_url: String,
    #[serde(skip)]
    pub rendering_url: Option<String>,
    #[serde(skip)]
    pub connection_url: Option<String>,
}

fn client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| reqwest::Client::builder().timeout(CONTROL_TIMEOUT).no_proxy().build().expect("http client"))
}

fn local_ipv4() -> Vec<Ipv4Addr> {
    let mut found = Vec::new();
    for probe in ["192.168.0.1:9", "10.0.0.1:9", "172.16.0.1:9", "8.8.8.8:9"] {
        if let Ok(socket) = UdpSocket::bind("0.0.0.0:0") {
            if socket.connect(probe).is_ok() {
                if let Ok(SocketAddr::V4(address)) = socket.local_addr() {
                    let ip = *address.ip();
                    if !ip.is_unspecified() && !ip.is_loopback() && !found.contains(&ip) {
                        found.push(ip);
                    }
                }
            }
        }
    }
    found
}

pub fn local_address_towards(target: IpAddr) -> Option<IpAddr> {
    let socket = UdpSocket::bind(if target.is_ipv4() { "0.0.0.0:0" } else { "[::]:0" }).ok()?;
    socket.connect(SocketAddr::new(target, 9)).ok()?;
    let ip = socket.local_addr().ok()?.ip();
    (!ip.is_unspecified()).then_some(ip)
}

fn search_on(bind: Ipv4Addr) -> Vec<String> {
    let mut locations = Vec::new();
    let Ok(socket) = UdpSocket::bind(SocketAddr::new(IpAddr::V4(bind), 0)) else {
        return locations;
    };
    let _ = socket.set_multicast_ttl_v4(4);
    let _ = socket.set_read_timeout(Some(Duration::from_millis(250)));
    for target in SEARCH_TARGETS {
        let request = format!("M-SEARCH * HTTP/1.1\r\nHOST: {SSDP_ADDRESS}\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: {target}\r\nUSER-AGENT: Kinuza/1 UPnP/1.1\r\n\r\n");
        for _ in 0..2 {
            let _ = socket.send_to(request.as_bytes(), SSDP_ADDRESS);
        }
    }
    let deadline = Instant::now() + Duration::from_secs(SEARCH_SECONDS);
    let mut buffer = [0u8; 4096];
    while Instant::now() < deadline {
        let Ok((length, _)) = socket.recv_from(&mut buffer) else { continue };
        let text = String::from_utf8_lossy(&buffer[..length]);
        if let Some(location) = header_value(&text, "location") {
            if !locations.contains(&location) {
                locations.push(location);
            }
        }
    }
    locations
}

fn header_value(message: &str, name: &str) -> Option<String> {
    message.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.trim().eq_ignore_ascii_case(name).then(|| value.trim().to_owned())
    })
}

pub async fn discover() -> Vec<Renderer> {
    let mut binds = local_ipv4();
    binds.push(Ipv4Addr::UNSPECIFIED);
    let searches: Vec<_> = binds.into_iter().map(|bind| tokio::task::spawn_blocking(move || search_on(bind))).collect();
    let mut locations: Vec<String> = Vec::new();
    for search in searches {
        if let Ok(found) = search.await {
            for location in found {
                if !locations.contains(&location) {
                    locations.push(location);
                }
            }
        }
    }
    let described = futures_join(locations.into_iter().map(describe)).await;
    let mut unique: HashMap<String, Renderer> = HashMap::new();
    for renderer in described.into_iter().flatten() {
        unique.entry(renderer.id.clone()).or_insert(renderer);
    }
    let mut list: Vec<Renderer> = unique.into_values().collect();
    list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    list
}

async fn futures_join<F, T>(jobs: impl Iterator<Item = F>) -> Vec<T>
where
    F: std::future::Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    let handles: Vec<_> = jobs.map(tokio::spawn).collect();
    let mut results = Vec::new();
    for handle in handles {
        if let Ok(result) = handle.await {
            results.push(result);
        }
    }
    results
}

pub async fn describe(location: String) -> Option<Renderer> {
    let response = client().get(&location).timeout(DESCRIPTION_TIMEOUT).send().await.ok()?;
    let xml = response.text().await.ok()?;
    parse_description(&location, &xml)
}

pub fn parse_description(location: &str, xml: &str) -> Option<Renderer> {
    let base = reqwest::Url::parse(location).ok()?;
    let url_base = tag_text(xml, "URLBase").and_then(|value| reqwest::Url::parse(&value).ok()).unwrap_or_else(|| base.clone());
    let mut transport = None;
    let mut rendering = None;
    let mut connection = None;
    for block in blocks(xml, "service") {
        let Some(kind) = tag_text(block, "serviceType") else { continue };
        let Some(control) = tag_text(block, "controlURL") else { continue };
        let Ok(url) = url_base.join(control.trim()) else { continue };
        if kind.starts_with("urn:schemas-upnp-org:service:AVTransport:") {
            transport = Some(url.to_string());
        } else if kind.starts_with("urn:schemas-upnp-org:service:RenderingControl:") {
            rendering = Some(url.to_string());
        } else if kind.starts_with("urn:schemas-upnp-org:service:ConnectionManager:") {
            connection = Some(url.to_string());
        }
    }
    let transport_url = transport?;
    let id = tag_text(xml, "UDN").unwrap_or_else(|| location.to_owned());
    let host = base.host_str().unwrap_or_default().to_owned();
    Some(Renderer {
        name: tag_text(xml, "friendlyName").filter(|name| !name.trim().is_empty()).unwrap_or_else(|| host.clone()),
        maker: tag_text(xml, "manufacturer").unwrap_or_default(),
        model: tag_text(xml, "modelName").unwrap_or_default(),
        address: host,
        id,
        transport_url,
        rendering_url: rendering,
        connection_url: connection,
    })
}

fn blocks<'a>(xml: &'a str, name: &str) -> Vec<&'a str> {
    let mut found = Vec::new();
    let mut rest = xml;
    while let Some(start) = find_open(rest, name) {
        let after = &rest[start..];
        let Some(open_end) = after.find('>') else { break };
        let body = &after[open_end + 1..];
        let Some(close) = find_close(body, name) else { break };
        found.push(&body[..close]);
        rest = &body[close..];
    }
    found
}

fn find_open(xml: &str, name: &str) -> Option<usize> {
    let mut offset = 0;
    while let Some(position) = xml[offset..].find('<') {
        let start = offset + position;
        let tag = &xml[start + 1..];
        let tag_name: String = tag.chars().take_while(|c| !c.is_whitespace() && *c != '>' && *c != '/').collect();
        let local = tag_name.rsplit(':').next().unwrap_or_default();
        if !tag_name.starts_with('/') && !tag_name.starts_with('?') && local == name {
            return Some(start);
        }
        offset = start + 1;
    }
    None
}

fn find_close(xml: &str, name: &str) -> Option<usize> {
    let mut offset = 0;
    while let Some(position) = xml[offset..].find("</") {
        let start = offset + position;
        let tag: String = xml[start + 2..].chars().take_while(|c| *c != '>').collect();
        if tag.trim().rsplit(':').next() == Some(name) {
            return Some(start);
        }
        offset = start + 2;
    }
    None
}

pub fn tag_text(xml: &str, name: &str) -> Option<String> {
    let start = find_open(xml, name)?;
    let after = &xml[start..];
    let open_end = after.find('>')?;
    if after[..open_end].ends_with('/') {
        return Some(String::new());
    }
    let body = &after[open_end + 1..];
    let close = find_close(body, name)?;
    Some(unescape(body[..close].trim()))
}

pub fn unescape(text: &str) -> String {
    text.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

pub fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
}

async fn soap(url: &str, service: &str, action: &str, arguments: &[(&str, String)]) -> Result<String> {
    let body: String = arguments.iter().map(|(name, value)| format!("<{name}>{}</{name}>", escape(value))).collect();
    let envelope = format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body><u:{action} xmlns:u=\"{service}\">{body}</u:{action}></s:Body></s:Envelope>"
    );
    let response = client()
        .post(url)
        .header("Content-Type", "text/xml; charset=\"utf-8\"")
        .header("SOAPAction", format!("\"{service}#{action}\""))
        .body(envelope)
        .send()
        .await
        .map_err(|error| anyhow!("cast_unreachable: {error}"))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        let code = tag_text(&text, "errorCode").unwrap_or_default();
        let description = tag_text(&text, "errorDescription").unwrap_or_default();
        bail!("cast_refused: {action} {status} {code} {description}");
    }
    Ok(text)
}

pub fn clock(seconds: f64) -> String {
    let total = seconds.max(0.0);
    let whole = total.floor() as u64;
    format!("{}:{:02}:{:02}.{:03}", whole / 3600, (whole % 3600) / 60, whole % 60, ((total - whole as f64) * 1000.0).round().min(999.0) as u64)
}

pub fn parse_clock(text: &str) -> Option<f64> {
    let text = text.trim();
    if text.is_empty() || text.eq_ignore_ascii_case("NOT_IMPLEMENTED") {
        return None;
    }
    let mut parts = text.split(':').rev();
    let seconds: f64 = parts.next()?.parse().ok()?;
    let minutes: f64 = parts.next().map(|part| part.parse().unwrap_or(0.0)).unwrap_or(0.0);
    let hours: f64 = parts.next().map(|part| part.parse().unwrap_or(0.0)).unwrap_or(0.0);
    Some(hours * 3600.0 + minutes * 60.0 + seconds)
}

pub struct Media<'a> {
    pub url: &'a str,
    pub mime: &'a str,
    pub title: &'a str,
    pub duration: Option<f64>,
    pub subtitle_url: Option<&'a str>,
    pub streaming: bool,
}

pub fn protocol_info(mime: &str, streaming: bool) -> String {
    let flags = if streaming { "DLNA.ORG_OP=00;DLNA.ORG_CI=1;DLNA.ORG_FLAGS=01300000000000000000000000000000" } else { "DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000" };
    format!("http-get:*:{mime}:{flags}")
}

pub fn didl(media: &Media) -> String {
    let duration = media.duration.filter(|value| *value > 0.0).map(|value| format!(" duration=\"{}\"", clock(value))).unwrap_or_default();
    let subtitle = media
        .subtitle_url
        .map(|url| {
            format!(
                "<res protocolInfo=\"http-get:*:text/srt:*\">{0}</res><sec:CaptionInfoEx sec:type=\"srt\">{0}</sec:CaptionInfoEx><sec:CaptionInfo sec:type=\"srt\">{0}</sec:CaptionInfo>",
                escape(url)
            )
        })
        .unwrap_or_default();
    format!(
        "<DIDL-Lite xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\" xmlns:dlna=\"urn:schemas-dlna-org:metadata-1-0/\" xmlns:sec=\"http://www.sec.co.kr/\"><item id=\"kinuza\" parentID=\"0\" restricted=\"1\"><dc:title>{}</dc:title><upnp:class>object.item.videoItem.movie</upnp:class><res protocolInfo=\"{}\"{duration}>{}</res>{subtitle}</item></DIDL-Lite>",
        escape(media.title),
        protocol_info(media.mime, media.streaming),
        escape(media.url),
    )
}

pub async fn load(renderer: &Renderer, media: &Media<'_>) -> Result<()> {
    let _ = soap(&renderer.transport_url, AV_TRANSPORT, "Stop", &[("InstanceID", "0".into())]).await;
    soap(
        &renderer.transport_url,
        AV_TRANSPORT,
        "SetAVTransportURI",
        &[("InstanceID", "0".into()), ("CurrentURI", media.url.to_owned()), ("CurrentURIMetaData", didl(media))],
    )
    .await?;
    play(renderer).await
}

pub async fn play(renderer: &Renderer) -> Result<()> {
    soap(&renderer.transport_url, AV_TRANSPORT, "Play", &[("InstanceID", "0".into()), ("Speed", "1".into())]).await.map(|_| ())
}

pub async fn pause(renderer: &Renderer) -> Result<()> {
    soap(&renderer.transport_url, AV_TRANSPORT, "Pause", &[("InstanceID", "0".into())]).await.map(|_| ())
}

pub async fn stop(renderer: &Renderer) -> Result<()> {
    soap(&renderer.transport_url, AV_TRANSPORT, "Stop", &[("InstanceID", "0".into())]).await.map(|_| ())
}

pub async fn seek(renderer: &Renderer, seconds: f64) -> Result<()> {
    let target = clock(seconds);
    let target = target.split('.').next().unwrap_or_default().to_owned();
    soap(&renderer.transport_url, AV_TRANSPORT, "Seek", &[("InstanceID", "0".into()), ("Unit", "REL_TIME".into()), ("Target", target)]).await.map(|_| ())
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transport {
    pub state: String,
    pub position: Option<f64>,
    pub duration: Option<f64>,
}

pub async fn transport(renderer: &Renderer) -> Result<Transport> {
    let info = soap(&renderer.transport_url, AV_TRANSPORT, "GetTransportInfo", &[("InstanceID", "0".into())]).await?;
    let position = soap(&renderer.transport_url, AV_TRANSPORT, "GetPositionInfo", &[("InstanceID", "0".into())]).await.unwrap_or_default();
    Ok(Transport {
        state: tag_text(&info, "CurrentTransportState").unwrap_or_default(),
        position: tag_text(&position, "RelTime").and_then(|value| parse_clock(&value)),
        duration: tag_text(&position, "TrackDuration").and_then(|value| parse_clock(&value)).filter(|value| *value > 0.0),
    })
}

pub async fn volume(renderer: &Renderer) -> Option<u32> {
    let url = renderer.rendering_url.as_ref()?;
    let answer = soap(url, RENDERING_CONTROL, "GetVolume", &[("InstanceID", "0".into()), ("Channel", "Master".into())]).await.ok()?;
    tag_text(&answer, "CurrentVolume")?.trim().parse().ok()
}

pub async fn set_volume(renderer: &Renderer, value: u32) -> Result<()> {
    let url = renderer.rendering_url.as_ref().ok_or_else(|| anyhow!("cast_no_volume"))?;
    soap(url, RENDERING_CONTROL, "SetVolume", &[("InstanceID", "0".into()), ("Channel", "Master".into()), ("DesiredVolume", value.min(100).to_string())]).await.map(|_| ())
}

pub async fn sink_formats(renderer: &Renderer) -> String {
    let Some(url) = renderer.connection_url.as_ref() else { return String::new() };
    match soap(url, CONNECTION_MANAGER, "GetProtocolInfo", &[]).await {
        Ok(answer) => tag_text(&answer, "Sink").unwrap_or_default().to_lowercase(),
        Err(_) => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMSUNG: &str = r#"<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><friendlyName>[TV] Samsung Q60 &amp; Co</friendlyName><manufacturer>Samsung Electronics</manufacturer><modelName>QE55Q60</modelName><UDN>uuid:abc-123</UDN><serviceList><service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType><controlURL>/upnp/control/RenderingControl1</controlURL></service><service><serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType><controlURL>/upnp/control/ConnectionManager1</controlURL></service><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/upnp/control/AVTransport1</controlURL></service></serviceList></device></root>"#;

    #[test]
    fn renderer_description_is_read() {
        let renderer = parse_description("http://192.168.1.50:9197/dmr", SAMSUNG).unwrap();
        assert_eq!(renderer.name, "[TV] Samsung Q60 & Co");
        assert_eq!(renderer.id, "uuid:abc-123");
        assert_eq!(renderer.address, "192.168.1.50");
        assert_eq!(renderer.transport_url, "http://192.168.1.50:9197/upnp/control/AVTransport1");
        assert_eq!(renderer.rendering_url.as_deref(), Some("http://192.168.1.50:9197/upnp/control/RenderingControl1"));
    }

    #[test]
    fn device_without_transport_is_skipped() {
        assert!(parse_description("http://1.2.3.4/x", "<root><device><friendlyName>NAS</friendlyName></device></root>").is_none());
    }

    #[test]
    fn soap_answers_and_clock_are_read() {
        let answer = r#"<s:Envelope><s:Body><u:GetPositionInfoResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><Track>1</Track><TrackDuration>01:02:03</TrackDuration><RelTime>0:00:42.500</RelTime></u:GetPositionInfoResponse></s:Body></s:Envelope>"#;
        assert_eq!(tag_text(answer, "RelTime").and_then(|value| parse_clock(&value)), Some(42.5));
        assert_eq!(tag_text(answer, "TrackDuration").and_then(|value| parse_clock(&value)), Some(3723.0));
        assert_eq!(parse_clock("NOT_IMPLEMENTED"), None);
        assert_eq!(clock(3723.25), "1:02:03.250");
    }

    #[test]
    fn metadata_escapes_names_and_links_subtitles() {
        let media = Media { url: "http://192.168.1.2:5000/cast/t/1/video.mkv", mime: "video/x-matroska", title: "Tom & Jerry <1>", duration: Some(5400.0), subtitle_url: Some("http://192.168.1.2:5000/cast/t/1/subs.srt"), streaming: true };
        let text = didl(&media);
        assert!(text.contains("Tom &amp; Jerry &lt;1&gt;"));
        assert!(text.contains("duration=\"1:30:00.000\""));
        assert!(text.contains("sec:CaptionInfoEx"));
        assert!(text.contains("DLNA.ORG_CI=1"));
    }
}
