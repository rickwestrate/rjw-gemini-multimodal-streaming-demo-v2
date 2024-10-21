let peerConnection;
let dataChannel;
let audioElement;

const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const statusElement = document.getElementById('status');
const logElement = document.getElementById('log');
const responseElement = document.getElementById('response');

function updateStatus(message) {
    statusElement.textContent = `Status: ${message}`;
    log(message);
}

function log(message) {
    console.log(message);
    const p = document.createElement('p');
    p.textContent = message;
    logElement.appendChild(p);
    logElement.scrollTop = logElement.scrollHeight;
}

async function connect() {
    const projectId = document.getElementById('projectId').value;
    const token = document.getElementById('token').value;
    
    if (!projectId || !token) {
        updateStatus('Please enter both Project ID and Access Token');
        return;
    }

    updateStatus('Connecting...');

    const endpoint = `https://us-central1-aiplatform.googleapis.com/v1beta1/projects/${projectId}/locations/us-central1/publishers/google/models/gemini-1.5-flash-001`;

    try {
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

        dataChannel = peerConnection.createDataChannel('messageChannel');
        dataChannel.onopen = () => log('Data channel opened');
        dataChannel.onclose = () => log('Data channel closed');
        dataChannel.onmessage = handleMessage;

        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        document.getElementById('localVideo').srcObject = stream;
        stream.getTracks().forEach(track => peerConnection.addTrack(track, stream));
        log('Added local stream to peer connection');

        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        log('Set local description');

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
        await peerConnection.setRemoteDescription(JSON.parse(sdpAnswer));
        log('Set remote description');

        updateStatus('Connected');
        connectBtn.disabled = true;
        disconnectBtn.disabled = false;
    } catch (error) {
        updateStatus(`Connection failed: ${error.message}`);
        console.error('Connection error:', error);
    }
}

function handleTrack(event) {
    log(`Received ${event.track.kind} track`);
    if (event.track.kind === 'audio') {
        if (!audioElement) {
            audioElement = new Audio();
            audioElement.autoplay = true;
        }
        audioElement.srcObject = event.streams[0];
        log('Audio playback set up');
    }
}

function disconnect() {
    if (peerConnection) {
        peerConnection.close();
    }
    if (dataChannel) {
        dataChannel.close();
    }
    if (audioElement) {
        audioElement.srcObject = null;
    }
    updateStatus('Disconnected');
    connectBtn.disabled = false;
    disconnectBtn.disabled = true;
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

function updateOverlay(text) {
    const overlay = document.getElementById('textOverlay');
    overlay.textContent = text;
}

connectBtn.addEventListener('click', connect);
disconnectBtn.addEventListener('click', disconnect);

updateStatus('Ready to connect');