# Kinuza

A Windows and Linux app for watching films, series and anime: a catalog with posters and descriptions, your own watch list, and a player that plays video from a torrent right away — streaming or while it downloads.

- Catalog, search and recommendations based on your ratings.
- Find releases right in the app, or use your own magnet link or `.torrent` file.
- Watch online without downloading, or save to disk.
- A player with audio track and subtitle choice, resume where you stopped, and the next episode.
- An episode release calendar and notifications about new ones.
- Interface in Russian, Ukrainian and English.

## Installation

1. Open the [latest release](https://github.com/Lembegor/Kinuza/releases/latest) and download `Kinuza_…_x64-setup.exe`.
2. Run it. No administrator rights are needed.

Windows will show two windows along the way, this is expected:

- **SmartScreen** ("Windows protected your PC") — click "More info" → "Run anyway".
- **Firewall** — allow network access, it is needed to download torrents.

There is nothing to update by hand: when a new version comes out, the app offers "Update and restart" by itself.

### Linux

The same release has three files, pick one:

- `Kinuza_…_amd64.deb` — for Ubuntu, Debian, Mint and similar: `sudo apt install ./Kinuza_…_amd64.deb`.
- `Kinuza-…x86_64.rpm` — for Fedora and openSUSE: `sudo dnf install ./Kinuza-…x86_64.rpm`.
- `Kinuza_…_amd64.AppImage` — for any distribution without installing: make the file executable (`chmod +x`) and run it.

On Linux, video plays in the built-in player; if it can't handle a format, Kinuza converts the video with FFmpeg (downloaded from the app with one click) or opens it in an external mpv or VLC. In GNOME the tray icon shows only with the AppIndicator extension, so minimizing to the tray is off by default there.

---

Posters, descriptions and episode lists are provided by TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.
