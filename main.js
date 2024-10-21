// Global variables
let peerConnection;
let dataChannel;
let audioElement;
let localStream;
let videoProcessor;
let videoGenerator;

// DOM elements
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const statusElement = document.getElementById('status');
const logElement = document.getElementById('log');
const responseElement = document.getElementById('response');
const localVideo = document.getElementById('localVideo');
const overlayTextInput = document.getElementById('overlayText');
const updateOverlayBtn = document.getElementById('updateOverlay');

// Logging function
function log(message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] ${type.toUpperCase()}: ${message}`);
    const p = document.createElement('p');
    p.textContent = `[${timestamp}] ${type.toUpperCase()}: ${message}`;
    p.className = type;
    logElement.appendChild(p);
    logElement.scrollTop = logElement.scrollHeight;
}

function updateStatus(message) {
    statusElement.textContent = `Status: ${message}`;
    log(message, 'status');
}

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

let overlayText = '';

let frameCount = 0;
const LOG_INTERVAL = 120; // Log every 30 frames (about once per second at 30fps)

async function videoFrameTransformer(frame, controller) {
    frameCount++;
    
    try {
        const width = frame.displayWidth;
        const height = frame.displayHeight;

        if (width === undefined || height === undefined) {
            controller.enqueue(frame);
            return;
        }

        if (frameCount % LOG_INTERVAL === 0) {
            log(`Processing video frame: width=${width}, height=${height}`);
        }
        
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d');

        ctx.drawImage(frame, 0, 0, width, height);

        if (overlayText) {
            ctx.font = '24px Arial';
            ctx.fillStyle = 'white';
            ctx.strokeStyle = 'black';
            ctx.lineWidth = 2;
            
            const words = overlayText.split(' ');
            let line = '';
            let y = 30;
            for (let i = 0; i < words.length; i++) {
                const testLine = line + words[i] + ' ';
                const metrics = ctx.measureText(testLine);
                if (metrics.width > width - 20 && i > 0) {
                    ctx.strokeText(line, 10, y);
                    ctx.fillText(line, 10, y);
                    line = words[i] + ' ';
                    y += 30;
                } else {
                    line = testLine;
                }
            }
            ctx.strokeText(line, 10, y);
            ctx.fillText(line, 10, y);

            if (frameCount % LOG_INTERVAL === 0) {
                log(`Applied overlay text: ${overlayText}`);
            }
        }

        const newFrame = new VideoFrame(canvas, {
            timestamp: frame.timestamp,
            duration: frame.duration
        });

        controller.enqueue(newFrame);
    } catch (error) {
        if (frameCount % LOG_INTERVAL === 0) {
            log(`Error in videoFrameTransformer: ${error.message}`, 'error');
            console.error('Detailed error:', error);
        }
        controller.enqueue(frame);
    } finally {
        frame.close();
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

function updateOverlayText() {
    overlayText = document.getElementById('overlayText').value;
    log(`Updated overlay text: ${overlayText}`);
    previewOverlay();
}

function previewOverlay() {
    const previewCanvas = document.createElement('canvas');
    previewCanvas.width = localVideo.videoWidth;
    previewCanvas.height = localVideo.videoHeight;
    const ctx = previewCanvas.getContext('2d');

    ctx.drawImage(localVideo, 0, 0, previewCanvas.width, previewCanvas.height);

    if (overlayText) {
        ctx.font = '24px Arial';
        ctx.fillStyle = 'white';
        ctx.strokeStyle = 'black';
        ctx.lineWidth = 2;
        
        const words = overlayText.split(' ');
        let line = '';
        let y = 30;
        for (let i = 0; i < words.length; i++) {
            const testLine = line + words[i] + ' ';
            const metrics = ctx.measureText(testLine);
            if (metrics.width > previewCanvas.width - 20 && i > 0) {
                ctx.strokeText(line, 10, y);
                ctx.fillText(line, 10, y);
                line = words[i] + ' ';
                y += 30;
            } else {
                line = testLine;
            }
        }
        ctx.strokeText(line, 10, y);
        ctx.fillText(line, 10, y);
    }

    // Replace the video element with the canvas temporarily
    const parent = localVideo.parentElement;
    parent.insertBefore(previewCanvas, localVideo);
    localVideo.style.display = 'none';
    previewCanvas.style.display = 'block';

    // Restore the video after 2 seconds
    setTimeout(() => {
        parent.removeChild(previewCanvas);
        localVideo.style.display = 'block';
    }, 2000);
}

// Event listeners
connectBtn.addEventListener('click', connect);
disconnectBtn.addEventListener('click', disconnect);
updateOverlayBtn.addEventListener('click', updateOverlayText);

// Initialize
updateStatus('Ready to connect');
log('Application initialized');