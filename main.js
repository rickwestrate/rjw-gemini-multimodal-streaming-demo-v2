console.log('main.js is loaded');

// Global variables
let peerConnection;
let dataChannel;
let audioElement;
let localStream;
let videoProcessor;
let videoGenerator;

// DOM elements
let connectBtn;
let disconnectBtn;
let statusElement;
let logElement;
let responseElement;
let localVideo;
let updateOverlayBtn;

// Overlay settings
let overlayText = '';
let overlayColor = '#FFFFFF';  // Default text color
let overlayBgColor = '#000000';  // Default background color
let overlayTransparency = 1;    // Default transparency (fully opaque)
let overlayPosition = 'top-left';  // Default position
let fontSize = 24; // Default font size

// Ensure DOM is fully loaded before attaching event listeners
document.addEventListener('DOMContentLoaded', function() {
    connectBtn = document.getElementById('connectBtn');
    disconnectBtn = document.getElementById('disconnectBtn');
    statusElement = document.getElementById('status');
    logElement = document.getElementById('log');
    responseElement = document.getElementById('response');
    localVideo = document.getElementById('localVideo');
    updateOverlayBtn = document.getElementById('updateOverlay');

    // Event listeners
    connectBtn.addEventListener('click', connect);
    disconnectBtn.addEventListener('click', disconnect);
    updateOverlayBtn.addEventListener('click', updateOverlayText);

    log('Application initialized and DOM fully loaded');
});

// Logging function
function log(message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] ${type.toUpperCase()}: ${message}`);
    
    if (logElement) {
        const p = document.createElement('p');
        p.textContent = `[${timestamp}] ${type.toUpperCase()}: ${message}`;
        p.className = type;
        logElement.appendChild(p);
        logElement.scrollTop = logElement.scrollHeight;
    }
}

function updateStatus(message) {
    statusElement.textContent = `Status: ${message}`;
    log(message, 'status');
}

function updateOverlayText() {
    overlayText = document.getElementById('overlayText').value;
    overlayColor = document.getElementById('overlayColor').value;
    overlayBgColor = document.getElementById('overlayBgColor').value;
    overlayTransparency = parseFloat(document.getElementById('overlayTransparency').value);
    overlayPosition = document.getElementById('overlayPosition').value;
    fontSize = parseInt(document.getElementById('fontSize').value, 10); // Get font size from input
    log(`Updated overlay: Text="${overlayText}", Text Color=${overlayColor}, Background Color=${overlayBgColor}, Transparency=${overlayTransparency}, Font Size=${fontSize}, Position=${overlayPosition}`);
}

async function videoFrameTransformer(frame, controller) {
    const width = frame.displayWidth;
    const height = frame.displayHeight;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');

    ctx.drawImage(frame, 0, 0, width, height);

    if (overlayText) {
        const boxPadding = 10;
        ctx.font = `${fontSize}px Arial`;
        const lines = wrapText(ctx, overlayText, width - 2 * boxPadding);
        
        // Dynamically resize the box based on text
        const boxWidth = width - 2 * boxPadding;
        const boxHeight = lines.length * (fontSize + 5) + 2 * boxPadding; // Adjust height for each line of text

        // Set the transparency for the entire text box
        ctx.globalAlpha = overlayTransparency;

        // Draw the background of the text box
        ctx.fillStyle = overlayBgColor;
        const x = overlayPosition.includes('right') ? width - boxWidth - boxPadding : boxPadding;
        const y = overlayPosition.includes('bottom') ? height - boxHeight - boxPadding : boxPadding;
        ctx.fillRect(x, y, boxWidth, boxHeight);

        // Set the text color and transparency
        ctx.fillStyle = overlayColor;
        ctx.globalAlpha = 1; // Text should be fully opaque

        // Draw the text line by line inside the box
        lines.forEach((line, i) => {
            ctx.fillText(line, x + boxPadding, y + (fontSize + 5) * (i + 1)); // Adjust vertical spacing for each line
        });
    }

    const newFrame = new VideoFrame(canvas, {
        timestamp: frame.timestamp,
        duration: frame.duration
    });

    controller.enqueue(newFrame);
    frame.close();
}

// Function to wrap text into lines that fit the canvas width
function wrapText(ctx, text, maxWidth) {
    const words = text.split(' ');
    const lines = [];
    let currentLine = words[0];

    for (let i = 1; i < words.length; i++) {
        const word = words[i];
        const width = ctx.measureText(currentLine + ' ' + word).width;
        if (width < maxWidth) {
            currentLine += ' ' + word;
        } else {
            lines.push(currentLine);
            currentLine = word;
        }
    }
    lines.push(currentLine); // Add the last line
    return lines;
}

// WebRTC connection logic remains unchanged (for simplicity)
async function connect() {
    log('Connect button clicked');
    const projectId = document.getElementById('projectId').value;
    const token = document.getElementById('token').value;

    if (!projectId || !token) {
        updateStatus('Please enter both Project ID and Access Token');
        return;
    }

    updateStatus('Connecting...');

    const endpoint = `https://us-central1-aiplatform.googleapis.com/v1beta1/projects/${projectId}/locations/us-central1/publishers/google/models/gemini-1.5-flash-001`;
    log(`Using endpoint: ${endpoint}`);

    try {
        log('Fetching WebRTC peer connection info...');
        const response = await fetch(`${endpoint}:fetchWebRTCPeerConnectionInfo`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({})
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const { serverConfig } = await response.json();
        log('Received server config');

        peerConnection = new RTCPeerConnection(serverConfig);
        log('Created peer connection');

        peerConnection.ontrack = handleTrack;
        peerConnection.onicecandidate = event => {
            log(`ICE candidate: ${event.candidate ? event.candidate.candidate : 'null'}`);
        };
        peerConnection.oniceconnectionstatechange = () => {
            log(`ICE connection state: ${peerConnection.iceConnectionState}`);
        };

        dataChannel = peerConnection.createDataChannel('messageChannel');
        dataChannel.onopen = () => log('Data channel opened');
        dataChannel.onclose = () => log('Data channel closed');
        dataChannel.onmessage = handleMessage;

        log('Requesting media devices...');
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        log('Media devices accessed successfully');
        const videoTrack = localStream.getVideoTracks()[0];
        log(`Video track settings: ${JSON.stringify(videoTrack.getSettings())}`);

        log('Setting up video processing pipeline...');
        videoProcessor = new MediaStreamTrackProcessor({ track: videoTrack });
        videoGenerator = new MediaStreamTrackGenerator({ kind: 'video' });

        const transformer = new TransformStream({
            transform: videoFrameTransformer
        });

        videoProcessor.readable
            .pipeThrough(transformer)
            .pipeTo(videoGenerator.writable)
            .then(() => log('Video processing pipeline established'))
            .catch(error => log(`Error in video processing pipeline: ${error.message}`, 'error'));

        log('Displaying local video...');
        const processedStream = new MediaStream([videoGenerator, ...localStream.getAudioTracks()]);
        localVideo.srcObject = processedStream;
        localVideo.onloadedmetadata = () => {
            log(`Local video dimensions: ${localVideo.videoWidth}x${localVideo.videoHeight}`);
            if (localVideo.videoWidth === 0 || localVideo.videoHeight === 0) {
                log('Warning: Local video dimensions are zero. Video may not be displayed correctly.', 'warn');
            }
        };

        // Ensure video is visible
        localVideo.style.display = 'block';
        localVideo.play().catch(e => log(`Error playing video: ${e.message}`, 'error'));

        log('Adding tracks to peer connection...');
        processedStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, processedStream);
            log(`Added ${track.kind} track to peer connection`);
        });

        log('Creating offer...');
        const offer = await peerConnection.createOffer();
        log('Setting local description...');
        await peerConnection.setLocalDescription(offer);

        log('Exchanging WebRTC session offer...');
        const exchangeResponse = await fetch(`${endpoint}:exchangeWebRTCSessionOffer`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ sdp_offer: JSON.stringify(offer) })
        });

        if (!exchangeResponse.ok) {
            throw new Error(`HTTP error! status: ${exchangeResponse.status}`);
        }

        const { sdpAnswer } = await exchangeResponse.json();
        log('Setting remote description...');
        await peerConnection.setRemoteDescription(JSON.parse(sdpAnswer));

        updateStatus('Connected');
        connectBtn.disabled = true;
        disconnectBtn.disabled = false;
        log('Connection established successfully');
    } catch (error) {
        updateStatus(`Connection failed: ${error.message}`);
        log(`Connection error: ${error.message}`, 'error');
        console.error('Detailed error:', error);
    }
}

function handleTrack(event) {
    log(`Received ${event.track.kind} track`);
    if (event.track.kind === 'audio') {
        if (!audioElement) {
            audioElement = new Audio();
            audioElement.autoplay = true;
        }
        audioElement.srcObject = new MediaStream([event.track]);
        log('Audio playback set up');
    }
}

function disconnect() {
    log('Disconnecting...');
    if (peerConnection) {
        peerConnection.close();
        log('Peer connection closed');
    }
    if (dataChannel) {
        dataChannel.close();
        log('Data channel closed');
    }
    if (audioElement) {
        audioElement.srcObject = null;
        log('Audio element reset');
    }
    if (localStream) {
        localStream.getTracks().forEach(track => {
            track.stop();
            log(`${track.kind} track stopped`);
        });
    }
    if (localVideo) {
        localVideo.srcObject = null;
        log('Local video reset');
    }
    updateStatus('Disconnected');
    connectBtn.disabled = false;
    disconnectBtn.disabled = true;
    log('Disconnection complete');
}

function handleMessage(event) {
    const text = new TextDecoder().decode(event.data);
    log(`Received message: ${text}`);

    const [type, content] = text.split(': ');
    const p = document.createElement('p');
    
    if (type === 'Transcripts') {
        p.textContent = `You: ${content}`;
    } else if (type === 'Responses') {
        p.textContent = `Gemini: ${content}`;
    } else {
        p.textContent = text;
    }

    responseElement.appendChild(p);
    responseElement.scrollTop = responseElement.scrollHeight;
}
