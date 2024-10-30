// ============================================================================
// Chat Components
// ============================================================================
function createMessage(type, content, timestamp) {
    const div = document.createElement('div');
    
    // Set styles based on message type
    switch(type) {
        case 'user':
            div.style.cssText = `
                background-color: #E3F2FD;
                color: #1565C0;
                margin: 8px 0 8px auto;
                padding: 12px;
                border-radius: 12px 12px 2px 12px;
                max-width: 80%;
                box-shadow: 0 1px 2px rgba(0,0,0,0.1);
                width: fit-content;
            `;
            break;
        case 'ai':
            div.style.cssText = `
                background-color: #F3E5F5;
                color: #6A1B9A;
                margin: 8px auto 8px 0;
                padding: 12px;
                border-radius: 12px 12px 12px 2px;
                max-width: 80%;
                box-shadow: 0 1px 2px rgba(0,0,0,0.1);
                width: fit-content;
            `;
            break;
        default:
            div.style.cssText = `
                background-color: #E8F5E9;
                color: #2E7D32;
                margin: 16px auto;
                padding: 8px 12px;
                border-radius: 8px;
                max-width: 90%;
                font-style: italic;
                text-align: center;
                border-left: 4px solid #4CAF50;
                width: fit-content;
            `;
    }
    
    // Add content and timestamp
    div.innerHTML = `
        <div style="margin: 4px 0">${content}</div>
        <div style="font-size: 11px; color: #5f6368; text-align: right; margin-top: 4px">${timestamp}</div>
    `;
    
    return div;
}

// ============================================================================
// State Management
// ============================================================================
class GeminiStreamingState {
    constructor() {
        this.reset();
    }

    reset() {
        this.connectionState = 'disconnected';
        this.overlayConfig = {
            text: '',
            color: '#FFFFFF',
            bgColor: '#000000',
            transparency: 1,
            position: 'top-left',
            fontSize: 24,
        };
        this.resources = {
            peerConnection: null,
            dataChannel: null,
            localStream: null,
            videoProcessor: null,
            videoGenerator: null,
            processingCanvas: null,
            processingContext: null
        };
    }

    updateOverlay(config) {
        if (!this.validateOverlayConfig(config)) {
            throw new Error('Invalid overlay configuration');
        }
        this.overlayConfig = { ...this.overlayConfig, ...config };
    }

    validateOverlayConfig(config) {
        const schema = {
            text: (text) => typeof text === 'string' && text.length <= 1000,
            color: (color) => /^#[0-9A-F]{6}$/i.test(color),
            bgColor: (color) => /^#[0-9A-F]{6}$/i.test(color),
            transparency: (t) => typeof t === 'number' && t >= 0 && t <= 1,
            position: (pos) => ['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(pos),
            fontSize: (size) => Number.isInteger(size) && size >= 8 && size <= 72
        };

        return Object.entries(config).every(([key, value]) => 
            !schema[key] || schema[key](value)
        );
    }
}
// ============================================================================
// Video Processing
// ============================================================================
class VideoProcessor {
    constructor(state) {
        this.state = state;
        this.textCache = new Map();
    }

    async initializeProcessing(videoTrack) {
        try {
            const processor = new MediaStreamTrackProcessor({ track: videoTrack });
            const generator = new MediaStreamTrackGenerator({ kind: 'video' });
            
            const { width, height } = videoTrack.getSettings();
            await this.initializeCanvas(width, height);
            
            const transformer = new TransformStream({
                transform: this.processVideoFrame.bind(this)
            });

            processor.readable
                .pipeThrough(transformer)
                .pipeTo(generator.writable)
                .catch(error => {
                    log(`Pipeline error: ${error.message}`, 'error');
                });

            this.state.resources.videoProcessor = processor;
            this.state.resources.videoGenerator = generator;

            return generator;
        } catch (error) {
            log(`Video processing initialization failed: ${error.message}`, 'error');
            throw error;
        }
    }

    async initializeCanvas(width, height) {
        try {
            const canvas = new OffscreenCanvas(width, height);
            const ctx = canvas.getContext('2d', {
                alpha: false,
                willReadFrequently: false,
                desynchronized: true
            });

            if (!ctx) {
                throw new Error('Failed to get canvas context');
            }

            this.state.resources.processingCanvas = canvas;
            this.state.resources.processingContext = ctx;
        } catch (error) {
            log(`Canvas initialization failed: ${error.message}`, 'error');
            throw error;
        }
    }

    async processVideoFrame(frame, controller) {
        try {
            const { processingCanvas, processingContext } = this.state.resources;
            const { overlayConfig } = this.state;

            if (!processingContext || !processingCanvas) {
                throw new Error('Processing context not initialized');
            }

            processingContext.drawImage(frame, 0, 0);

            if (overlayConfig.text) {
                await this.drawOverlay(processingContext, frame.displayWidth, frame.displayHeight);
            }

            const newFrame = new VideoFrame(processingCanvas, {
                timestamp: frame.timestamp,
                duration: frame.duration
            });

            controller.enqueue(newFrame);
        } catch (error) {
            log(`Frame processing error: ${error.message}`, 'error');
        } finally {
            frame.close();
        }
    }

    async drawOverlay(ctx, width, height) {
        const { text, color, bgColor, transparency, position, fontSize } = this.state.overlayConfig;
        
        try {
            const lines = await this.getWrappedText(ctx, text, width - 20, fontSize);
            
            const boxPadding = 10;
            const lineHeight = fontSize * 1.2;
            const boxWidth = width - 2 * boxPadding;
            const boxHeight = lines.length * lineHeight + 2 * boxPadding;

            const [x, y] = this.calculateOverlayPosition(position, width, height, boxWidth, boxHeight);

            // Draw background with transparency
            ctx.globalAlpha = transparency;
            ctx.fillStyle = bgColor;
            ctx.fillRect(x, y, boxWidth, boxHeight);

            // Draw text at full opacity
            ctx.globalAlpha = 1;
            ctx.fillStyle = color;
            ctx.font = `${fontSize}px Arial`;
            ctx.textBaseline = 'top';

            lines.forEach((line, i) => {
                ctx.fillText(line, x + boxPadding, y + boxPadding + (lineHeight * i));
            });
        } catch (error) {
            log(`Overlay drawing error: ${error.message}`, 'error');
        }
    }

    async getWrappedText(ctx, text, maxWidth, fontSize) {
        const cacheKey = `${text}-${maxWidth}-${fontSize}`;
        
        if (!this.textCache.has(cacheKey)) {
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
            
            lines.push(currentLine);
            this.textCache.set(cacheKey, lines);

            // Limit cache size
            if (this.textCache.size > 100) {
                const oldestKey = this.textCache.keys().next().value;
                this.textCache.delete(oldestKey);
            }
        }

        return this.textCache.get(cacheKey);
    }

    calculateOverlayPosition(position, width, height, boxWidth, boxHeight) {
        const padding = 10;
        switch (position) {
            case 'top-right': 
                return [width - boxWidth - padding, padding];
            case 'bottom-left': 
                return [padding, height - boxHeight - padding];
            case 'bottom-right': 
                return [width - boxWidth - padding, height - boxHeight - padding];
            default: // top-left
                return [padding, padding];
        }
    }

    async cleanup() {
        try {
            const { videoProcessor, videoGenerator } = this.state.resources;
            
            if (videoProcessor?.readable) {
                await videoProcessor.readable.cancel();
            }
            if (videoGenerator?.writable) {
                await videoGenerator.writable.abort();
            }
            
            this.textCache.clear();
            
            this.state.resources.videoProcessor = null;
            this.state.resources.videoGenerator = null;
            this.state.resources.processingCanvas = null;
            this.state.resources.processingContext = null;
        } catch (error) {
            log(`Cleanup error: ${error.message}`, 'error');
        }
    }
}
// ============================================================================
// WebRTC Connection Management
// ============================================================================
class WebRTCManager {
    constructor(state, videoProcessor) {
        this.state = state;
        this.videoProcessor = videoProcessor;
        this.retryCount = 0;
        this.maxRetries = 3;
        this.backoffMs = 1000;
        this.audioElement = null;
    }

    async connect(projectId, token, systemInstructions) {
        try {
            console.log('Connect called with system instructions:', systemInstructions);
            
            if (!projectId?.trim() || !token?.trim()) {
                throw new Error('Project ID and Access Token are required');
            }
            
            const environment = document.getElementById('environment').value;
            const model = document.getElementById('model').value;
            
            const baseUrl = environment === 'autopush' 
                ? 'https://us-central1-autopush-aiplatform.sandbox.googleapis.com'
                : 'https://us-central1-aiplatform.googleapis.com';
                
            const endpoint = `${baseUrl}/v1beta1/projects/${projectId}/locations/us-central1/publishers/google/models/${model}`;
            
            console.log('Using endpoint:', endpoint); // Debug log
            
            this.projectId = projectId;
            this.token = token;
            this.systemInstructions = systemInstructions;
            
            updateStatus('connecting');
    
            const apiEndpointEl = document.getElementById('apiEndpoint');
            const modelNameEl = document.getElementById('modelName');
            
            if (apiEndpointEl) apiEndpointEl.textContent = endpoint;
            if (modelNameEl) modelNameEl.textContent = model;
            
            const serverConfig = await this.fetchPeerConnectionInfo(endpoint, token);
            await this.setupPeerConnection(serverConfig);
            await this.setupMediaStream();
            await this.createAndSendOffer(endpoint, token, systemInstructions);
            
            updateStatus('connected');
            
        } catch (error) {
            await this.handleConnectionError(error);
        }
    }

    async fetchPeerConnectionInfo(endpoint, token) {
        console.log('Fetching peer connection info'); // Debug log
        const response = await fetch(`${endpoint}:fetchWebRTCPeerConnectionInfo`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({})
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('Peer connection info error:', errorText); // Debug log
            throw new Error(`Server error: ${response.status} ${errorText}`);
        }

        const { serverConfig } = await response.json();
        console.log('Received server config:', serverConfig); // Debug log
        return serverConfig;
    }

    async setupPeerConnection(serverConfig) {
        try {
            const peerConnection = new RTCPeerConnection(serverConfig);
            
            peerConnection.ontrack = this.handleTrack.bind(this);
            peerConnection.onicecandidate = event => {
                log(`ICE candidate: ${event.candidate ? event.candidate.candidate : 'null'}`);
            };
            
            peerConnection.onconnectionstatechange = () => {
                log(`Connection state: ${peerConnection.connectionState}`);
                if (peerConnection.connectionState === 'connected') {
                    startMetricsCollection();
                }
            };
            
            peerConnection.oniceconnectionstatechange = () => {
                log(`ICE connection state: ${peerConnection.iceConnectionState}`);
                if (peerConnection.iceConnectionState === 'failed') {
                    this.handleConnectionError(new Error('ICE connection failed'));
                }
            };
        
            const dataChannel = peerConnection.createDataChannel('messageChannel');
            this.setupDataChannel(dataChannel);
        
            this.state.resources.peerConnection = peerConnection;
            this.state.resources.dataChannel = dataChannel;
        } catch (error) {
            log(`Peer connection setup failed: ${error.message}`, 'error');
            throw error;
        }
    }

    setupDataChannel(dataChannel) {
        dataChannel.onopen = () => {
            log('Data channel opened');
            dataChannelOpen = true;
            updateConnectionStatus('connected');
        };
        dataChannel.onclose = () => {
            log('Data channel closed');
            dataChannelOpen = false;
            updateConnectionStatus('disconnected');
        };
        dataChannel.onmessage = this.handleMessage.bind(this);
        dataChannel.onerror = (error) => log(`Data channel error: ${error.message}`, 'error');
    }

    async createAndSendOffer(endpoint, token, systemInstructions) {
        console.log('Creating offer with system instructions:', systemInstructions);
        
        const { peerConnection } = this.state.resources;
        if (!peerConnection) {
            throw new Error('Peer connection not initialized');
        }
        
        try {
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
    
            // First try with system instructions
            if (systemInstructions) {
                try {
                    const requestBody = {
                        sdp_offer: JSON.stringify(offer),
                        system_instruction: {
                            'role': 'system',
                            'parts': { 'text': systemInstructions }
                        }
                    };
    
                    const response = await fetch(`${endpoint}:exchangeWebRTCSessionOffer`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`
                        },
                        body: JSON.stringify(requestBody)
                    });
    
                    if (response.ok) {
                        const responseData = await response.json();
                        await peerConnection.setRemoteDescription(JSON.parse(responseData.sdpAnswer));
                        log('Connected with system instructions');
                        return;
                    }
                    // If we get here, the first attempt failed
                    log('System instructions not supported, retrying without...', 'warn');
                } catch (error) {
                    console.log('Failed with system instructions, retrying without:', error);
                }
            }
    
            // Fallback: Try without system instructions
            const basicRequestBody = {
                sdp_offer: JSON.stringify(offer)
            };
    
            const response = await fetch(`${endpoint}:exchangeWebRTCSessionOffer`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify(basicRequestBody)
            });
    
            if (!response.ok) {
                throw new Error(`Offer exchange failed: ${response.status}`);
            }
    
            const responseData = await response.json();
            await peerConnection.setRemoteDescription(JSON.parse(responseData.sdpAnswer));
            log('Connected without system instructions (not supported in this environment)', 'warn');
            
            // Update UI to show system instructions aren't available
            const sessionReady = document.getElementById('sessionReady');
            if (sessionReady) {
                sessionReady.innerHTML = `
                    <i class="fas fa-check-circle"></i>
                    Session ready! (System instructions not supported in this environment)
                `;
                sessionReady.style.backgroundColor = '#fef7e0';
                sessionReady.style.color = '#ea8600';
            }
            
        } catch (error) {
            console.error('Complete offer error:', error);
            throw new Error(`Offer creation/exchange failed: ${error.message}`);
        }
    }

    handleMessage(event) {
        const text = new TextDecoder().decode(event.data);
        log(`Received message: ${text}`, 'debug');
    
        let messageType = 'system';
        let content = text;
    
        if (text.includes('Transcript:')) {
            messageType = 'user';
            content = text.replace('Transcript:', '').trim();
        } else if (text.includes('Response:')) {
            messageType = 'ai';
            content = text.replace('Response:', '').trim();
        }
    
        // Remove any leading special characters
        content = content.replace(/^[^a-zA-Z0-9\s]+/, '').trim();
    
        const responseElement = document.getElementById('response');
        const timestamp = new Date().toLocaleTimeString([], {
            hour: 'numeric',
            minute: '2-digit',
            hour12: true
        });
    
        const wrapper = document.createElement('div');
        wrapper.style.cssText = `
            width: 100%;
            margin: 8px 0;
            display: flex;
            flex-direction: column;
            align-items: ${messageType === 'user' ? 'flex-end' : 'flex-start'};
            animation: fadeIn 0.3s ease-in-out;
        `;
    
        const label = document.createElement('div');
        label.style.cssText = `
            font-size: 12px;
            margin-bottom: 4px;
            opacity: 0.7;
            font-weight: 500;
            ${messageType === 'user' ? 'color: #1565C0;' : 'color: #6A1B9A;'}
        `;
        label.textContent = messageType === 'user' ? 'User' : 'Gemini';
        wrapper.appendChild(label);
    
        const bubble = document.createElement('div');
        bubble.style.cssText = messageType === 'user' ? `
            background-color: #E3F2FD;
            color: #1565C0;
            padding: 12px;
            border-radius: 12px 12px 2px 12px;
            max-width: 80%;
            box-shadow: 0 1px 2px rgba(0,0,0,0.1);
            width: fit-content;
        ` : `
            background-color: #F3E5F5;
            color: #6A1B9A;
            padding: 12px;
            border-radius: 12px 12px 12px 2px;
            max-width: 80%;
            box-shadow: 0 1px 2px rgba(0,0,0,0.1);
            width: fit-content;
        `;
    
        const contentDiv = document.createElement('div');
        contentDiv.style.cssText = 'margin: 4px 0;';
        contentDiv.textContent = content;
    
        const timeDiv = document.createElement('div');
        timeDiv.style.cssText = 'font-size: 11px; color: #5f6368; text-align: right; margin-top: 4px;';
        timeDiv.textContent = timestamp;
    
        bubble.appendChild(contentDiv);
        bubble.appendChild(timeDiv);
        wrapper.appendChild(bubble);
        responseElement.appendChild(wrapper);
        responseElement.scrollTop = responseElement.scrollHeight;
    }

    handleTrack(event) {
        log(`Received ${event.track.kind} track`);
        
        if (event.track.kind === 'audio') {
            try {
                if (!this.audioElement) {
                    this.audioElement = new Audio();
                    this.audioElement.autoplay = true;
                }
                
                const audioStream = new MediaStream([event.track]);
                this.audioElement.srcObject = audioStream;
                
                this.audioElement.play().catch(e => {
                    log(`Audio play failed: ${e.message}`, 'error');
                });
                
                log('Audio playback configured');
            } catch (error) {
                log(`Audio setup error: ${error.message}`, 'error');
            }
        }
    }

    async setupMediaStream() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ 
                video: { 
                    width: { ideal: 1280 },
                    height: { ideal: 720 },
                    frameRate: { ideal: 30 }
                }, 
                audio: true 
            });

            const videoTrack = stream.getVideoTracks()[0];
            const processedTrack = await this.videoProcessor.initializeProcessing(videoTrack);
            
            const processedStream = new MediaStream([
                processedTrack,
                ...stream.getAudioTracks()
            ]);

            this.setupLocalVideo(processedStream);
            this.addTracksToConnection(processedStream);
            
            this.state.resources.localStream = stream;
            
        } catch (error) {
            throw new Error(`Media setup failed: ${error.message}`);
        }
    }

    setupLocalVideo(stream) {
        const localVideo = document.getElementById('localVideo');
        if (!localVideo) {
            throw new Error('Local video element not found');
        }

        localVideo.srcObject = stream;
        localVideo.style.display = 'block';
        
        localVideo.onloadedmetadata = () => {
            if (localVideo.videoWidth === 0 || localVideo.videoHeight === 0) {
                log('Warning: Local video dimensions are zero', 'warn');
            }
            localVideo.play().catch(e => log(`Video playback error: ${e.message}`, 'error'));
        };
    }

    addTracksToConnection(stream) {
        const { peerConnection } = this.state.resources;
        if (!peerConnection) {
            throw new Error('Peer connection not initialized');
        }

        stream.getTracks().forEach(track => {
            peerConnection.addTrack(track, stream);
            log(`Added ${track.kind} track to peer connection`);
        });
    }

    async handleConnectionError(error) {
        log(`Connection error: ${error.message}`, 'error');
        
        if (this.retryCount < this.maxRetries) {
            this.retryCount++;
            const backoffTime = this.backoffMs * Math.pow(2, this.retryCount - 1);
            
            log(`Retrying connection in ${backoffTime}ms (attempt ${this.retryCount}/${this.maxRetries})`, 'warn');
            
            setTimeout(() => {
                this.connect(this.projectId, this.token, this.systemInstructions);
            }, backoffTime);
        } else {
            updateStatus('error');
            throw error;
        }
    }

    async disconnect() {
        try {
            const { peerConnection, dataChannel, localStream } = this.state.resources;

            if (dataChannel) {
                dataChannel.close();
            }

            if (peerConnection) {
                peerConnection.close();
            }

            if (localStream) {
                localStream.getTracks().forEach(track => track.stop());
            }

            if (this.audioElement) {
                this.audioElement.srcObject = null;
                this.audioElement = null;
            }

            await this.videoProcessor.cleanup();
            
            const localVideo = document.getElementById('localVideo');
            if (localVideo) {
                localVideo.srcObject = null;
                localVideo.style.display = 'none';
            }

            this.state.reset();
            this.retryCount = 0;
            
            updateStatus('disconnected');
            log('Disconnection complete');
        } catch (error) {
            log(`Disconnect error: ${error.message}`, 'error');
            throw error;
        }
    }
}
// ============================================================================
// Main Application Logic
// ============================================================================
let state, videoProcessor, webRTCManager;
let dataChannelOpen = false;

function updateConnectionStatus(status) {
    const statusEl = document.getElementById('connectionStatus');
    const statusTextEl = statusEl.querySelector('.status-text');
    statusEl.className = `connection-status status-${status}`;
    statusTextEl.textContent = status.charAt(0).toUpperCase() + status.slice(1);
    
    // Show ready indicator when both connected and data channel is open
    const sessionReady = document.getElementById('sessionReady');
    if (status === 'connected' && dataChannelOpen) {
        sessionReady.style.display = 'flex';
    } else {
        sessionReady.style.display = 'none';
    }
}

function log(message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] ${type.toUpperCase()}: ${message}`);
    
    const logElement = document.getElementById('log');
    if (logElement) {
        const logEntry = document.createElement('div');
        logEntry.className = `log-entry ${type}`;
        logEntry.innerHTML = `[${timestamp}] ${message}`;
        logElement.appendChild(logEntry);
        logElement.scrollTop = logElement.scrollHeight;
    }
}

function updateStatus(message) {
    const statusElement = document.getElementById('status');
    if (statusElement) {
        statusElement.textContent = `Status: ${message}`;
    }
    log(`Status updated: ${message}`, 'status');
    updateConnectionStatus(message);
}

async function initializeApp() {
    try {
        log('Initializing application...');
        
        // Initialize core components
        state = new GeminiStreamingState();
        videoProcessor = new VideoProcessor(state);
        webRTCManager = new WebRTCManager(state, videoProcessor);

        // Set up UI event listeners
        const connectBtn = document.getElementById('connectBtn');
        const disconnectBtn = document.getElementById('disconnectBtn');
        const updateOverlayBtn = document.getElementById('updateOverlay');
        const fontSizeSlider = document.getElementById('fontSize');
        const transparencySlider = document.getElementById('overlayTransparency');
        const responseElement = document.getElementById('response');

        if (connectBtn) {
            connectBtn.addEventListener('click', handleConnect);
            connectBtn.disabled = false;
        }

        if (disconnectBtn) {
            disconnectBtn.addEventListener('click', handleDisconnect);
            disconnectBtn.disabled = true;
        }

        if (updateOverlayBtn) {
            updateOverlayBtn.addEventListener('click', handleOverlayUpdate);
        }

        if (responseElement) {
            responseElement.style.cssText = 'max-height: calc(100vh - 300px); overflow-y: auto; padding: 16px;';
            responseElement.parentElement.style.cssText = 'height: 100%; display: flex; flex-direction: column;';
        }

        // Set up UI value displays
        if (fontSizeSlider) {
            fontSizeSlider.addEventListener('input', (e) => {
                const fontSizeValue = document.getElementById('fontSizeValue');
                if (fontSizeValue) {
                    fontSizeValue.textContent = `${e.target.value}px`;
                }
            });
        }

        if (transparencySlider) {
            transparencySlider.addEventListener('input', (e) => {
                const transparencyValue = document.getElementById('transparencyValue');
                if (transparencyValue) {
                    const percentage = Math.round(e.target.value * 100);
                    transparencyValue.textContent = `${percentage}%`;
                }
            });
        }

        // Initialize color picker previews
        document.getElementById('overlayColor').addEventListener('input', (e) => {
            document.getElementById('textColorPreview').style.backgroundColor = e.target.value;
        });
        
        document.getElementById('overlayBgColor').addEventListener('input', (e) => {
            document.getElementById('bgColorPreview').style.backgroundColor = e.target.value;
        });

        log('Application initialized successfully');
    } catch (error) {
        log(`Initialization error: ${error.message}`, 'error');
        throw error;
    }
}

async function handleConnect() {
    try {
        const projectId = document.getElementById('projectId')?.value;
        const token = document.getElementById('token')?.value;
        const systemInstructions = document.getElementById('systemInstructions')?.value;  // Make sure this ID matches your HTML

        console.log('Connecting with system instructions:', systemInstructions); // Debug log

        if (!projectId || !token) {
            throw new Error('Project ID and Access Token are required');
        }

        const connectBtn = document.getElementById('connectBtn');
        const disconnectBtn = document.getElementById('disconnectBtn');

        if (connectBtn) connectBtn.disabled = true;
        if (disconnectBtn) disconnectBtn.disabled = false;

        // Clear previous conversation
        const responseElement = document.getElementById('response');
        if (responseElement) {
            responseElement.innerHTML = '';
        }
        
        await webRTCManager.connect(projectId, token, systemInstructions);  // Make sure we're passing the system instructions here
    } catch (error) {
        log(`Connection failed: ${error.message}`, 'error');
        
        const connectBtn = document.getElementById('connectBtn');
        const disconnectBtn = document.getElementById('disconnectBtn');
        
        if (connectBtn) connectBtn.disabled = false;
        if (disconnectBtn) disconnectBtn.disabled = true;
        
        throw error;
    }
}

async function handleDisconnect() {
    try {
        const disconnectBtn = document.getElementById('disconnectBtn');
        if (disconnectBtn) {
            disconnectBtn.disabled = true;
        }

        await webRTCManager.disconnect();
        updateConnectionStatus('disconnected');

        const connectBtn = document.getElementById('connectBtn');
        if (connectBtn) {
            connectBtn.disabled = false;
        }
    } catch (error) {
        log(`Disconnect failed: ${error.message}`, 'error');
        throw error;
    }
}

function handleOverlayUpdate() {
    try {
        const config = {
            text: document.getElementById('overlayText')?.value || '',
            color: document.getElementById('overlayColor')?.value || '#FFFFFF',
            bgColor: document.getElementById('overlayBgColor')?.value || '#000000',
            transparency: parseFloat(document.getElementById('overlayTransparency')?.value || '1'),
            position: document.getElementById('overlayPosition')?.value || 'top-left',
            fontSize: parseInt(document.getElementById('fontSize')?.value || '24', 10)
        };

        state.updateOverlay(config);
        log('Overlay settings updated successfully');
    } catch (error) {
        log(`Overlay update failed: ${error.message}`, 'error');
    }
}

function startMetricsCollection() {
    const metricsInterval = setInterval(async () => {
        try {
            const { peerConnection } = state.resources;
            if (!peerConnection) {
                clearInterval(metricsInterval);
                return;
            }

            const stats = await peerConnection.getStats();
            const metrics = {
                bytesReceived: 0,
                bytesSent: 0,
                packetsLost: 0,
                roundTripTime: 0
            };

            stats.forEach(stat => {
                if (stat.type === 'inbound-rtp') {
                    metrics.bytesReceived += stat.bytesReceived || 0;
                    metrics.packetsLost += stat.packetsLost || 0;
                } else if (stat.type === 'outbound-rtp') {
                    metrics.bytesSent += stat.bytesSent || 0;
                } else if (stat.type === 'remote-inbound-rtp' && stat.roundTripTime) {
                    metrics.roundTripTime = stat.roundTripTime;
                }
            });

            // Update metrics display
            const elements = {
                bytesReceived: document.getElementById('bytesReceived'),
                bytesSent: document.getElementById('bytesSent'),
                packetsLost: document.getElementById('packetsLost'),
                roundTripTime: document.getElementById('roundTripTime')
            };

            if (elements.bytesReceived) elements.bytesReceived.textContent = formatBytes(metrics.bytesReceived);
            if (elements.bytesSent) elements.bytesSent.textContent = formatBytes(metrics.bytesSent);
            if (elements.packetsLost) elements.packetsLost.textContent = metrics.packetsLost;
            if (elements.roundTripTime) {
                elements.roundTripTime.textContent = metrics.roundTripTime ? 
                    `${(metrics.roundTripTime * 1000).toFixed(1)} ms` : 'N/A';
            }

        } catch (error) {
            log('Error collecting metrics: ' + error.message, 'error');
        }
    }, 1000);

    // Store interval ID for cleanup
    state.metricsInterval = metricsInterval;
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', initializeApp);

// Cleanup on page unload
window.addEventListener('beforeunload', async () => {
    if (state?.connectionState === 'connected') {
        await webRTCManager.disconnect();
    }
    if (state?.metricsInterval) {
        clearInterval(state.metricsInterval);
    }
});