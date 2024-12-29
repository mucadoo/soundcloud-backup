require('dotenv').config();
const { google } = require('googleapis');
const axios = require('axios');
const cheerio = require("cheerio");
const stream = require('stream');

// Load environment variables or default values
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const GOOGLE_DRIVE_FILE_ID = process.env.GOOGLE_DRIVE_FILE_ID;
const SOUNDCLOUD_USER_ID = process.env.SOUNDCLOUD_USER_ID;

exports.lambdaHandler = async (event) => {
  const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
  oauth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });

  const drive = google.drive({
    version: 'v3',
    auth: oauth2Client,
  });

  try {
    // Extract client_id dynamically
    const SOUND_CLOUD_CLIENT_ID = await extractClientIdFromScripts();

    // Fetch existing file from Google Drive
    const oldFile = await fetchGoogleDriveFile(drive, GOOGLE_DRIVE_FILE_ID);

    // Fetch playlists from SoundCloud
    const userPlaylists = await fetchSoundCloudPlaylists(SOUND_CLOUD_CLIENT_ID);

    // Process playlists and update the file
    const updatedFile = await updateFileContent(oldFile, userPlaylists, SOUND_CLOUD_CLIENT_ID);

    // Upload updated file to Google Drive
    await uploadFileToGoogleDrive(drive, GOOGLE_DRIVE_FILE_ID, updatedFile);

    return { message: 'File updated successfully' };
  } catch (error) {
    console.error('Error:', error);
    return { error: error.message };
  }
};

async function extractClientIdFromScripts() {
  try {
    // Step 1: Fetch the SoundCloud home page
    const response = await axios.get("https://soundcloud.com/");
    const html = response.data;

    // Load the HTML into Cheerio
    const $ = cheerio.load(html);

    // Step 2: Get all script tags with a `src` attribute
    const scriptSources = $('script[src]')
        .map((_, el) => $(el).attr("src"))
        .toArray();

    if (scriptSources.length === 0) {
      throw new Error("No external scripts found.");
    }

    // Step 3: Loop through each script file until we find the client_id
    for (const src of scriptSources) {
      const scriptUrl = src.startsWith("http") ? src : `https://soundcloud.com${src}`;
      console.log(`Checking script: ${scriptUrl}`);

      try {
        const scriptResponse = await axios.get(scriptUrl);
        const scriptContent = scriptResponse.data;

        // Use regex to extract the client_id
        const match = scriptContent.match(/,?client_id\s*[:=]\s*"(.*?)"/);
        if (match && match[1]) {
          console.log(`client_id found in ${scriptUrl}`);
          return match[1];
        }
      } catch (err) {
        console.error(`Error fetching script ${scriptUrl}:`, err.message);
        // Continue checking the next script
      }
    }

    throw new Error("client_id not found in any script file.");
  } catch (error) {
    console.error("Error fetching client_id:", error.message);
    return null;
  }
}

// Function to fetch a file from Google Drive
async function fetchGoogleDriveFile(drive, fileId) {
  try {
    const res = await drive.files.get({
      fileId,
      alt: 'media',
    });
    return res.data;
  } catch (error) {
    console.error('Error fetching Google Drive file:', error);
    throw new Error('Failed to fetch file from Google Drive');
  }
}

// Function to fetch playlists from SoundCloud
async function fetchSoundCloudPlaylists(clientId) {
  try {
    const res = await axios.get(`https://api-v2.soundcloud.com/users/${SOUNDCLOUD_USER_ID}/playlists_without_albums`, {
      params: { client_id: clientId },
    });
    return res.data;
  } catch (error) {
    console.error('Error fetching SoundCloud playlists:', error);
    throw new Error('Failed to fetch playlists from SoundCloud');
  }
}

// Function to fetch track details from SoundCloud
async function fetchTrackDetails(trackId, clientId) {
  try {
    const res = await axios.get('https://api-v2.soundcloud.com/tracks', {
      params: {
        client_id: clientId,
        ids: trackId,
      },
    });
    return res.data[0];
  } catch (error) {
    console.error(`Error fetching details for track ID ${trackId}:`, error);
    throw new Error(`Failed to fetch track details for ID ${trackId}`);
  }
}

// Function to update the content of the file based on playlists
async function updateFileContent(oldFile, userPlaylists, clientId) {
  const updatedFile = Array.isArray(oldFile) ? oldFile : [];

  for (const set of userPlaylists.collection) {
    let oldSet = updatedFile.find((oldSet) => oldSet.name === set.permalink);

    if (!oldSet) {
      oldSet = {
        user: set.user.username,
        name: set.permalink,
        tracks: [],
        lastUpdated: new Date(),
      };
      updatedFile.push(oldSet);
    } else {
      oldSet.lastUpdated = new Date();
      oldSet.tracks.forEach((track) => (track.exists = false));
    }

    for (const track of set.tracks) {
      let trackDetails = track;

      // Fetch detailed track data if the title is missing
      if (!track.title) {
        try {
          trackDetails = await fetchTrackDetails(track.id, clientId);
        } catch (error) {
          console.error('Skipping track due to fetch failure:', track.id);
          continue;
        }
      }

      let oldTrack = oldSet.tracks.find((t) => t.id === trackDetails.id);
      if (!oldTrack) {
        oldTrack = {
          id: trackDetails.id,
          name: trackDetails.title,
          desc: trackDetails.description,
          authorName: trackDetails.user.full_name,
          authorNick: trackDetails.user.username,
          authorUrl: trackDetails.user.permalink,
          exists: true,
        };
        oldSet.tracks.push(oldTrack);
      } else {
        oldTrack.exists = true;
      }
    }
  }

  return updatedFile;
}

// Function to upload a file to Google Drive
async function uploadFileToGoogleDrive(drive, fileId, content) {
  const bufferStream = new stream.PassThrough();
  bufferStream.end(Uint8Array.from(Buffer.from(JSON.stringify(content, null, 2), 'utf8')));

  try {
    // Update existing file on Google Drive
    await drive.files.update({
      fileId: fileId,
      media: {
        mimeType: 'application/json',
        body: bufferStream,
      },
    });
    console.log('File updated successfully');
  } catch (error) {
    console.error('Error uploading file to Google Drive:', error);
    throw new Error('Failed to upload file to Google Drive');
  }
}
