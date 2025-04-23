# Jellyfin + Transmission Torrent Uploader

A minimal web application to:

- Authenticate users against a **Jellyfin** server.
- Provide a UI to upload `.torrent` files.
- Use the uploaded torrent to start a download in **Transmission**.

## 📦 Features

- Jellyfin user authentication
- Clean, Jellyfin-style dark UI
- Upload torrent file via web form
- Sends file to Transmission using JSON-RPC API
- Environment variable support for config

---

## 🔧 Requirements

- Node.js (v18+ recommended)
- A running Jellyfin server
- A running Transmission server (with RPC enabled)

---

## 🚀 Getting Started

### Clone the project

```bash
git clone https://github.com/your-username/jellyfin-transmission-uploader.git
cd jellyfin-transmission-uploader
```

### Install

```bash
npm install
```

### Install

```bash
npm run
```

then open `http://localhost:3000/`
