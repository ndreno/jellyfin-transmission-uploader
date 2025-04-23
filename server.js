// File: server.js

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;

const jellyfinServer = process.env.JELLYFIN_SERVER || "http://localhost:8096"

const upload = multer({ dest: 'uploads/' });

app.use(express.static('public'));
app.use(express.json());

// Jellyfin login
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const response = await axios.post(`${jellyfinServer}/Users/AuthenticateByName`, {
      Username: username,
      Pw: password,
    }, {
      headers: {
        'Content-Type': 'application/json',
        'X-Emby-Authorization': `MediaBrowser Client="TorrentUploader", Device="WebApp", DeviceId="1", Version="1.0"`
      }
    });
    res.json({ token: response.data.AccessToken });
  } catch (error) {
    res.status(401).json({ error: 'Authentication failed' });
  }
});

// Upload and send torrent to Transmission
app.post('/api/upload', upload.single('torrent'), async (req, res) => {
  const torrentPath = req.file.path;

  try {
    const torrentData = fs.readFileSync(torrentPath);
    const base64Torrent = torrentData.toString('base64');

    // Get Transmission session ID
    const sessionResp = await axios.post(`${process.env.TRANSMISSION_URL}/transmission/rpc`, {}, {
      auth: {
        username: process.env.TRANS_USER,
        password: process.env.TRANS_PASS
      }
    }).catch(err => err.response);

    const sessionId = sessionResp.headers['x-transmission-session-id'];

    // Send torrent
    const addResp = await axios.post(`${process.env.TRANSMISSION_URL}/transmission/rpc`, {
      method: 'torrent-add',
      arguments: { metainfo: base64Torrent }
    }, {
      headers: { 'X-Transmission-Session-Id': sessionId },
      auth: {
        username: process.env.TRANS_USER,
        password: process.env.TRANS_PASS
      }
    });

    res.json({ result: addResp.data.result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to upload torrent' });
  } finally {
    fs.unlinkSync(torrentPath);
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
