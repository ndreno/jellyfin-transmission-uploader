// File: server.js

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// --- Logging Setup ---
// Basic console logging. Consider using a library like 'winston' or 'pino' for production.
const log = {
  info: (...args) => console.log('[INFO]', ...args),
  debug: (...args) => console.log('[DEBUG]', ...args), // Use for detailed steps
  warn: (...args) => console.warn('[WARN]', ...args),
  error: (...args) => console.error('[ERROR]', ...args),
};
// --- End Logging Setup ---

const app = express();
const port = process.env.PORT || 3000;

// --- Environment Variable Check ---
log.info('--- Configuration ---');
log.info(`PORT: ${port}`);
log.info(`JELLYFIN_SERVER: ${process.env.JELLYFIN_SERVER || "http://localhost:8096 (Default)"}`);
log.info(`TRANSMISSION_URL: ${process.env.TRANSMISSION_URL ? process.env.TRANSMISSION_URL : 'MISSING!'}`);
log.info(`TRANS_USER: ${process.env.TRANS_USER ? 'Set' : 'MISSING!'}`);
log.info(`TRANS_PASS: ${process.env.TRANS_PASS ? 'Set (********)' : 'MISSING!'}`);
if (!process.env.TRANSMISSION_URL || !process.env.TRANS_USER || !process.env.TRANS_PASS) {
    log.error('CRITICAL: Transmission environment variables (TRANSMISSION_URL, TRANS_USER, TRANS_PASS) are not fully set in .env file!');
}
log.info('--- End Configuration ---');
// --- End Environment Variable Check ---


const jellyfinServer = process.env.JELLYFIN_SERVER || "http://localhost:8096"

// Configure Multer destination and error handling
const UPLOAD_DIR = 'uploads/';
if (!fs.existsSync(UPLOAD_DIR)){
    log.info(`Creating upload directory: ${UPLOAD_DIR}`);
    fs.mkdirSync(UPLOAD_DIR);
}
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, UPLOAD_DIR);
    },
    filename: function (req, file, cb) {
        // Use a unique name to avoid collisions, keep extension
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 } // Example: Limit file size to 10MB
});


app.use(express.static('public'));
app.use(express.json());

// Jellyfin login
app.post('/api/login', async (req, res) => {
  log.info('Received POST /api/login');
  const { username, password } = req.body;

  // Basic validation
  if (!username || !password) {
      log.warn('Login attempt with missing username or password.');
      return res.status(400).json({ error: 'Username and password are required.' });
  }

  log.debug(`Attempting Jellyfin login for user: ${username}`); // Avoid logging password
  const loginUrl = `${jellyfinServer}/Users/AuthenticateByName`;
  log.debug(`Jellyfin Auth URL: ${loginUrl}`);

  try {
    const response = await axios.post(loginUrl, {
      Username: username,
      Pw: password, // Sending password here
    }, {
      headers: {
        'Content-Type': 'application/json',
        'X-Emby-Authorization': `MediaBrowser Client="TorrentUploader", Device="WebApp", DeviceId="1", Version="1.0"`
      }
    });
    log.info(`Jellyfin login successful for user: ${username}`);
    res.json({ token: response.data.AccessToken });
  } catch (error) {
    log.error(`Jellyfin authentication failed for user: ${username}`);
    if (error.response) {
      // The request was made and the server responded with a status code
      // that falls out of the range of 2xx
      log.error('Error Response Data:', error.response.data);
      log.error('Error Response Status:', error.response.status);
      log.error('Error Response Headers:', error.response.headers);
      res.status(error.response.status || 401).json({ error: 'Authentication failed', details: error.response.data });
    } else if (error.request) {
      // The request was made but no response was received
      log.error('Error Request:', error.request);
      res.status(500).json({ error: 'Authentication failed - No response from Jellyfin server' });
    } else {
      // Something happened in setting up the request that triggered an Error
      log.error('Error Message:', error.message);
      res.status(500).json({ error: 'Authentication failed - Client setup error' });
    }
  }
});

// Upload and send torrent to Transmission
app.post('/api/upload', upload.single('torrent'), async (req, res) => {
  log.info('Received POST /api/upload');

  if (!req.file) {
    log.error('Upload failed: No file received in the request.');
    return res.status(400).json({ error: 'No torrent file uploaded.' });
  }

  const torrentPath = req.file.path;
  log.debug(`File uploaded successfully. Details:`, {
      fieldname: req.file.fieldname,
      originalname: req.file.originalname,
      encoding: req.file.encoding,
      mimetype: req.file.mimetype,
      destination: req.file.destination,
      filename: req.file.filename,
      path: req.file.path,
      size: req.file.size
  });

  // --- Transmission Credentials Check ---
  const transUrl = process.env.TRANSMISSION_URL;
  const transUser = process.env.TRANS_USER;
  const transPass = process.env.TRANS_PASS;

  if (!transUrl || !transUser || !transPass) {
      log.error('Transmission credentials or URL are missing in environment variables.');
      fs.unlink(torrentPath, (err) => { // Use async unlink
          if (err) log.error(`Failed to delete temp file ${torrentPath} after config error:`, err);
          else log.debug(`Deleted temp file ${torrentPath} after config error.`);
      });
      return res.status(500).json({ error: 'Server configuration error: Transmission details missing.' });
  }
  // --- End Credentials Check ---

  let sessionId = null; // Define sessionId outside try blocks

  try {
    log.debug(`Reading torrent file from path: ${torrentPath}`);
    const torrentData = fs.readFileSync(torrentPath);
    log.debug(`Torrent file read successfully, size: ${torrentData.length} bytes.`);
    const base64Torrent = torrentData.toString('base64');
    log.debug(`Torrent data encoded to base64 (length: ${base64Torrent.length}).`);

    const rpcUrl = `${transUrl}/transmission/rpc`;
    const auth = { username: transUser, password: transPass };

    // --- Step 1: Get Transmission Session ID ---
    log.debug(`Attempting to get Transmission session ID from: ${rpcUrl}`);
    try {
        // Make a preliminary request which is expected to fail with 409 Conflict
        await axios.post(rpcUrl, {}, { auth });
        // If it doesn't fail, something is unusual, but maybe it works? Log a warning.
        log.warn('Initial request to Transmission did not return 409, proceeding anyway.');
        // In this unusual case, we assume no session ID needed or it's handled differently.
        // For safety, let's try getting it from a potential header anyway if the lib supports it (unlikely).
        // sessionId = sessionResp?.headers?.['x-transmission-session-id']; // Might be undefined

    } catch (error) {
        if (error.response && error.response.status === 409) {
            // This is the EXPECTED path
            sessionId = error.response.headers['x-transmission-session-id'];
            if (sessionId) {
                log.info(`Successfully obtained Transmission session ID.`);
                log.debug(`Session ID: ${sessionId}`); // Be careful logging sensitive IDs in prod
            } else {
                log.error('Received 409 Conflict from Transmission, but X-Transmission-Session-Id header was MISSING!');
                log.error('Transmission Response Headers:', error.response.headers);
                throw new Error('Failed to get Transmission session ID header despite 409 response.');
            }
        } else {
            // An UNEXPECTED error occurred trying to get the session ID
            log.error('Unexpected error while trying to get Transmission session ID.');
            if (error.response) {
                log.error('Error Response Status:', error.response.status);
                log.error('Error Response Data:', error.response.data);
            } else {
                log.error('Error Message:', error.message);
            }
            throw error; // Re-throw the unexpected error
        }
    }

    // Ensure we have a session ID before proceeding
    if (!sessionId) {
         log.error("Failed to obtain Transmission session ID. Cannot proceed with torrent addition.");
         // Clean up the uploaded file
         fs.unlink(torrentPath, (err) => {
            if (err) log.error(`Failed to delete temp file ${torrentPath} after session ID failure:`, err);
            else log.debug(`Deleted temp file ${torrentPath} after session ID failure.`);
         });
         return res.status(500).json({ error: 'Failed to communicate with Transmission: Could not get session ID.' });
    }

    // --- Step 2: Send Torrent to Transmission ---
    log.debug(`Sending 'torrent-add' request to Transmission: ${rpcUrl}`);
    const payload = {
      method: 'torrent-add',
      arguments: { metainfo: base64Torrent }
    };
    log.debug('Transmission request payload:', { method: payload.method, arguments: { metainfo: `base64_string_length_${base64Torrent.length}` } }); // Don't log the full base64 string

    const addResp = await axios.post(rpcUrl, payload, {
      headers: { 'X-Transmission-Session-Id': sessionId },
      auth: auth
    });

    log.info('Successfully sent torrent to Transmission.');
    log.debug('Transmission add response status:', addResp.status);
    log.debug('Transmission add response data:', addResp.data);

    // Check Transmission's response result
    if (addResp.data.result === 'success') {
        log.info('Transmission confirmed torrent addition success.');
        res.json({ result: 'success', details: addResp.data.arguments }); // Send back success and any details
    } else {
        log.warn(`Transmission reported non-success result: ${addResp.data.result}`);
        res.status(400).json({ error: 'Transmission reported an issue adding the torrent.', details: addResp.data });
    }

  } catch (err) {
    log.error('An error occurred during the torrent upload process:');
    if (err.response) {
        // Error from Axios request (likely to Transmission add call)
        log.error('Axios Response Error Status:', err.response.status);
        log.error('Axios Response Error Data:', err.response.data);
        log.error('Axios Response Error Headers:', err.response.headers);
        res.status(err.response.status || 500).json({ error: 'Failed to send torrent to Transmission', details: err.response.data });
    } else if (err.request) {
        // Request made but no response received
        log.error('Axios Request Error: No response received.', err.request);
        res.status(504).json({ error: 'Failed to send torrent to Transmission: No response' });
    } else {
        // Setup error or other synchronous error (e.g., fs.readFileSync)
        log.error('Error Message:', err.message);
        log.error('Error Stack:', err.stack); // Log stack trace for other errors
        res.status(500).json({ error: 'Internal server error during torrent processing.' });
    }
  } finally {
    // --- Clean up the uploaded file ---
    if (fs.existsSync(torrentPath)) {
        log.debug(`Attempting to delete temporary file: ${torrentPath}`);
        fs.unlink(torrentPath, (unlinkErr) => {
            if (unlinkErr) {
                log.error(`Failed to delete temporary file ${torrentPath}:`, unlinkErr);
            } else {
                log.debug(`Successfully deleted temporary file: ${torrentPath}`);
            }
        });
    } else {
        log.debug(`Temporary file ${torrentPath} was already deleted or never existed.`);
    }
  }
});

app.listen(port, () => {
  log.info(`Server running at http://localhost:${port}`);
});