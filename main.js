// main.js - Enhanced implementation with proper separation of concerns
console.log('Initializing Gemini Multimodal Streaming Demo...');

// ============================================================================
// State Management
// ============================================================================
class GeminiStreamingState {
    constructor() {
        this.listeners = new Map();
        this.reset();
    }

    reset() {
        this.connectionState = 'disconnected';
        this.error = null;
        this.overlayConfig = {
            text: '',
            color: '#FFFFFF',
            bgColor: '#000000',
            transparency: 1,
            position: 'top-left',
            fontSize: 24,
            lastUpdate: Date.now()
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
        this.metrics = {
            frameCount: 0,
            droppedFrames: 0,
            lastFrameTime: 0,
            averageProcessingTime: 0
        };
    }

    on(event, callback) {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, new Set());
        }
        this.listeners.get(event).add(callback);
    }

    emit(event, data) {
        if (this.listeners.has(event)) {
            this.listeners.get(event).forEach(callback => callback(data));
        }
    }

    updateOverlay(config) {
        if (!this.validateOverlayConfig(config)) {
            throw new Error('Invalid overlay configuration');
        }
        this.overlayConfig = { ...this.overlayConfig, ...config, lastUpdate: Date.now() };
        this.emit('overlayUpdated', this.overlayConfig);
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

    updateConnectionState(state, error = null) {
        this.connectionState = state;
        this.error = error;
        this.emit('connectionStateChanged', { state, error, timestamp: Date.now() });
        updateStatus(`${state}${error ? ': ' + error.message : ''}`);
    }

    updateResources(resources) {
        this.resources = { ...this.resources, ...resources };
        this.emit('resourcesUpdated', this.resources);
    }

    updateMetrics(metrics) {
        this.metrics = { ...this.metrics, ...metrics };
        this.emit('metricsUpdated', this.metrics);
    }
}

// ============================================================================
// Video Processing
// ============================================================================
class VideoProcessor {
    constructor(state) {
        this.state = state;
        this.textCache = new Map();
        this.frameMetrics = {
            lastProcessingTimes: new Array(60).fill(0),
            currentIndex: 0
        };
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
                    this.state.updateConnectionState('error', error);
                });

            this.state.updateResources({
                videoProcessor: processor,
                videoGenerator: generator
            });

            return generator;
        } catch (error) {
            log(`Video processing initialization failed: ${error.message}`, 'error');
            throw error;
        }
    }

    async initializeCanvas(width, height) {
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d', {
            alpha: false,
            willReadFrequently: false,
            desynchronized: true
        });

        this.state.updateResources({
            processingCanvas: canvas,
            processingContext: ctx
        });
    }

    async processVideoFrame(frame, controller) {
        const startTime = performance.now();
        
        try {
            const { processingCanvas, processingContext } = this.state.resources;
            const { overlayConfig } = this.state;

            processingContext.drawImage(frame, 0, 0);

            if (overlayConfig.text) {
                await this.drawOverlay(processingContext, frame.displayWidth, frame.displayHeight);
            }

            const newFrame = new VideoFrame(processingCanvas, {
                timestamp: frame.timestamp,
                duration: frame.duration
            });

            controller.enqueue(newFrame);
            this.updateMetrics(startTime);
        } catch (error) {
            log(`Frame processing error: ${error.message}`, 'error');
            this.state.updateMetrics({ droppedFrames: this.state.metrics.droppedFrames + 1 });
        } finally {
            frame.close();
        }
    }

    async drawOverlay(ctx, width, height) {
        const { text, color, bgColor, transparency, position, fontSize } = this.state.overlayConfig;
        const lines = await this.getWrappedText(ctx, text, width - 20, fontSize);
        
        const boxPadding = 10;
        const lineHeight = fontSize * 1.2;
        const boxWidth = width - 2 * boxPadding;
        const boxHeight = lines.length * lineHeight + 2 * boxPadding;

        const [x, y] = this.calculateOverlayPosition(position, width, height, boxWidth, boxHeight);

        ctx.globalAlpha = transparency;
        ctx.fillStyle = bgColor;
        ctx.fillRect(x, y, boxWidth, boxHeight);

        ctx.globalAlpha = 1;
        ctx.fillStyle = color;
        ctx.font = `${fontSize}px Arial`;
        ctx.textBaseline = 'top';

        lines.forEach((line, i) => {
            ctx.fillText(line, x + boxPadding, y + boxPadding + (lineHeight * i));
        });
    }

    async getWrappedText(ctx, text, maxWidth, fontSize) {
        const cacheKey = `${text}-${maxWidth}-${fontSize}`;
        
        if (!this.textCache.has(cacheKey)) {
            const lines = [];
            const words = text.split(' ');
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
            case 'top-right': return [width - boxWidth - padding, padding];
            case 'bottom-left': return [padding, height - boxHeight - padding];
            case 'bottom-right': return [width - boxWidth - padding, height - boxHeight - padding];
            default: return [padding, padding]; // top-left
        }
    }

    updateMetrics(startTime) {
        const processingTime = performance.now() - startTime;
        
        this.frameMetrics.lastProcessingTimes[this.frameMetrics.currentIndex] = processingTime;
        this.frameMetrics.currentIndex = (this.frameMetrics.currentIndex + 1) % 60;

        const averageProcessingTime = this.frameMetrics.lastProcessingTimes.reduce((a, b) => a + b) / 60;

        this.state.updateMetrics({
            frameCount: this.state.metrics.frameCount + 1,
            lastFrameTime: processingTime,
            averageProcessingTime
        });
    }

    async cleanup() {
        const { videoProcessor, videoGenerator } = this.state.resources;
        
        try {
            if (videoProcessor?.readable) {
                await videoProcessor.readable.cancel();
            }
            if (videoGenerator?.writable) {
                await videoGenerator.writable.abort();
            }
            
            this.textCache.clear();
            this.frameMetrics.lastProcessingTimes.fill(0);
            
            this.state.updateResources({
                videoProcessor: null,
                videoGenerator: null,
                processingCanvas: null,
                processingContext: null
            });
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
        
        // Bind methods
        this.handleTrack = this.handleTrack.bind(this);
        this.handleMessage = this.handleMessage.bind(this);
    }

    async connect(projectId, token) {
        try {
            this.validateConnectionParams(projectId, token);
            this.projectId = projectId;
            this.token = token;
            
            const endpoint = `https://us-central1-aiplatform.googleapis.com/v1beta1/projects/${projectId}/locations/us-central1/publishers/google/models/gemini-1.5-flash-002`;
            
            await this.initializeConnection(endpoint, token);

            // Update API Endpoint and Model Name in WebRTC Metrics
            document.getElementById('apiEndpoint').textContent = endpoint; 
            document.getElementById('modelName').textContent = 'gemini-1.5-flash-002'; // Or get this dynamically
            
        } catch (error) {
            await this.handleConnectionError(error);
        }
    }

    validateConnectionParams(projectId, token) {
        if (!projectId?.trim() || !token?.trim()) {
            throw new Error('Project ID and Access Token are required');
        }
    }

    async initializeConnection(endpoint, token) {
        this.state.updateConnectionState('connecting');
        
        const serverConfig = await this.fetchPeerConnectionInfo(endpoint, token);
        await this.setupPeerConnection(serverConfig);
        await this.setupMediaStream();
        await this.createAndSendOffer(endpoint, token);
        
        this.state.updateConnectionState('connected');
    }

    async fetchPeerConnectionInfo(endpoint, token) {
        const response = await fetch(`${endpoint}:fetchWebRTCPeerConnectionInfo`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({})
        });

        if (!response.ok) {
            throw new Error(`Server error: ${response.status}`);
        }

        const { serverConfig } = await response.json();
        return serverConfig;
    }

    async setupPeerConnection(serverConfig) {
        const peerConnection = new RTCPeerConnection(serverConfig);
        
        peerConnection.ontrack = this.handleTrack;
        
        peerConnection.onicecandidate = event => {
            log(`ICE candidate: ${event.candidate ? event.candidate.candidate : 'null'}`);
        };
        
        peerConnection.oniceconnectionstatechange = () => {
            log(`ICE connection state: ${peerConnection.iceConnectionState}`);
            if (peerConnection.iceConnectionState === 'failed') {
                this.handleIceFailure();
            }
        };

        const dataChannel = peerConnection.createDataChannel('messageChannel');
        this.setupDataChannel(dataChannel);

        this.state.updateResources({ peerConnection, dataChannel });
    }

    setupDataChannel(dataChannel) {
        dataChannel.onopen = () => log('Data channel opened');
        dataChannel.onclose = () => log('Data channel closed');
        dataChannel.onmessage = this.handleMessage;
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
            
            this.state.updateResources({ localStream: stream });
            
        } catch (error) {
            throw new Error(`Media setup failed: ${error.message}`);
        }
    }

    setupLocalVideo(stream) {
        const localVideo = document.getElementById('localVideo');
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
        stream.getTracks().forEach(track => {
            peerConnection.addTrack(track, stream);
            log(`Added ${track.kind} track to peer connection`);
        });
    }

    async createAndSendOffer(endpoint, token) {
        const { peerConnection } = this.state.resources;
        
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);

        const response = await fetch(`${endpoint}:exchangeWebRTCSessionOffer`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ sdp_offer: JSON.stringify(offer) })
        });

        if (!response.ok) {
            throw new Error(`Offer exchange failed: ${response.status}`);
        }

        const { sdpAnswer } = await response.json();
        await peerConnection.setRemoteDescription(JSON.parse(sdpAnswer));
    }

    async handleConnectionError(error) {
        log(`Connection error: ${error.message}`, 'error');
        
        if (this.retryCount < this.maxRetries) {
            this.retryCount++;
            const backoffTime = this.backoffMs * Math.pow(2, this.retryCount - 1);
            
            log(`Retrying connection in ${backoffTime}ms (attempt ${this.retryCount}/${this.maxRetries})`, 'warn');
            
            setTimeout(() => {
                this.connect(this.projectId, this.token);
            }, backoffTime);
        } else {
            this.state.updateConnectionState('error', error);
            throw error;
        }
    }

    handleIceFailure() {
        const error = new Error('ICE connection failed');
        this.handleConnectionError(error);
    }

    handleMessage(event) {
        const text = new TextDecoder().decode(event.data);
        log(`Received message: ${text}`, 'debug');
    
        let [type, ...contentParts] = text.split(': ');
        type = type.trim().replace(/[^a-zA-Z]/g, '');
        const content = contentParts.join(': ').trim();
    
        const responseElement = document.getElementById('response');
        const timestamp = new Date().toLocaleTimeString([], {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true
        });
    
        let currentGroup = responseElement.lastChild; 
    
        switch (type) {
          case 'Transcripts':
            if (!currentGroup || currentGroup.classList.contains('gemini-message-group')) {
              currentGroup = document.createElement('div');
              currentGroup.className = 'message-group user-message-group'; 
              responseElement.appendChild(currentGroup);
            }
    
            const userMessage = document.createElement('div');
            userMessage.className = 'message user-message';
            userMessage.innerHTML = `
                    <div class="message-header">You</div>
                    <div class="message-content">${content}</div>
                    <div class="message-time">${timestamp}</div>
                `;
            currentGroup.appendChild(userMessage);
            break;
          case 'Responses':
            if (!currentGroup || currentGroup.classList.contains('user-message-group')) {
              currentGroup = document.createElement('div');
              currentGroup.className = 'message-group gemini-message-group'; 
              responseElement.appendChild(currentGroup);
            }
    
            const geminiMessage = document.createElement('div');
            geminiMessage.className = 'message gemini-message';
            geminiMessage.innerHTML = `
                    <div class="message-header">Gemini</div>
                    <div class="message-content">${content}</div>
                    <div class="message-time">${timestamp}</div>
                `;
            currentGroup.appendChild(geminiMessage);
            break;
          default:
            const messageDiv = document.createElement('div');
            messageDiv.className = 'message system-message';
            messageDiv.innerHTML = `
                    <div class="message-content">${content}</div>
                    <div class="message-time">${timestamp}</div>
                `;
            responseElement.appendChild(messageDiv);
        }
    
        responseElement.scrollTop = responseElement.scrollHeight;
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
            this.state.updateConnectionState('disconnected');
            this.retryCount = 0;
            
            log('Disconnection complete');
        } catch (error) {
            log(`Disconnect error: ${error.message}`, 'error');
            throw error;
        }
    }
}

// ============================================================================
// Performance Monitoring
// ============================================================================
class PerformanceMonitor {
    constructor(state) {
        this.state = state;
        this.metricsInterval = null;
        this.lastWarningTime = 0;
        this.warningInterval = 30000;
        
        // Bind to state updates
        this.state.on('metricsUpdated', this.updateMetricsDisplay.bind(this));
    }

    start() {
        // Update stats every 2 seconds
        this.metricsInterval = setInterval(() => this.gatherWebRTCStats(), 2000);
    }

    stop() {
        if (this.metricsInterval) {
            clearInterval(this.metricsInterval);
            this.metricsInterval = null;
        }
        this.updateMetricsDisplay({
            audioLevel: 0,
            bytesReceived: 0,
            bytesSent: 0,
            packetsLost: 0,
            roundTripTime: 0,
            processingTime: 0
        });
    }

    async gatherWebRTCStats() {
        const { peerConnection } = this.state.resources;
        if (!peerConnection) return;

        try {
            const stats = await peerConnection.getStats();
            const metricsData = {
                audioLevel: 0,
                bytesReceived: 0,
                bytesSent: 0,
                packetsLost: 0,
                roundTripTime: 0,
                processingTime: this.state.metrics.averageProcessingTime || 0
            };

            stats.forEach(stat => {
                if (stat.type === 'inbound-rtp' && stat.kind === 'audio') {
                    metricsData.bytesReceived = stat.bytesReceived;
                    metricsData.packetsLost = stat.packetsLost;
                }
                if (stat.type === 'outbound-rtp') {
                    metricsData.bytesSent = stat.bytesSent;
                }
                if (stat.type === 'remote-inbound-rtp') {
                    metricsData.roundTripTime = stat.roundTripTime;
                }
                if (stat.type === 'media-source' && stat.kind === 'audio') {
                    metricsData.audioLevel = stat.audioLevel;
                }
            });

            this.state.updateMetrics(metricsData);
            this.updateMetricsDisplay(metricsData);
        } catch (error) {
            console.error('Error gathering WebRTC stats:', error);
        }
    }

    updateMetricsDisplay(metrics) {
        const elements = {
            bytesReceived: document.getElementById('bytesReceived'),
            bytesSent: document.getElementById('bytesSent'),
            packetsLost: document.getElementById('packetsLost'),
            roundTripTime: document.getElementById('roundTripTime'),
            processingTime: document.getElementById('processingTime')
        };

        if (elements.bytesReceived) {
            elements.bytesReceived.textContent = this.formatBytes(metrics.bytesReceived);
        }
        if (elements.bytesSent) {
            elements.bytesSent.textContent = this.formatBytes(metrics.bytesSent);
        }
        if (elements.packetsLost) {
            elements.packetsLost.textContent = metrics.packetsLost || 0;
        }
        if (elements.roundTripTime) {
            elements.roundTripTime.textContent = 
                metrics.roundTripTime ? `${(metrics.roundTripTime * 1000).toFixed(1)} ms` : 'N/A';
        }
        if (elements.processingTime) {
            elements.processingTime.textContent = `${metrics.processingTime.toFixed(1)} ms`;
        }
    }

    formatBytes(bytes) {
        if (!bytes) return '0 B';
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${sizes[i]}`;
    }
}

// ============================================================================
// Main Application Logic
// ============================================================================
let state, videoProcessor, webRTCManager, performanceMonitor;

// Enhanced logging function
function log(message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] ${type.toUpperCase()}: ${message}`);
    
    const logElement = document.getElementById('log');
    if (logElement) {
        const p = document.createElement('p');
        p.textContent = `[${timestamp}] ${type.toUpperCase()}: ${message}`;
        p.className = type;
        logElement.appendChild(p);
        logElement.scrollTop = logElement.scrollHeight;
    }
}

function updateStatus(message) {
    const statusElement = document.getElementById('status');
    if (statusElement) {
        statusElement.textContent = `Status: ${message}`;
    }
    log(message, 'status');
}

async function initializeApp() {
    try {
        // Initialize core components
        state = new GeminiStreamingState();
        videoProcessor = new VideoProcessor(state);
        webRTCManager = new WebRTCManager(state, videoProcessor);
        performanceMonitor = new PerformanceMonitor(state);

        // Set up UI event listeners
        document.getElementById('connectBtn')?.addEventListener('click', handleConnect);
        document.getElementById('disconnectBtn')?.addEventListener('click', handleDisconnect);
        document.getElementById('updateOverlay')?.addEventListener('click', handleOverlayUpdate);

        // Set up state change listeners
        state.on('connectionStateChanged', ({ state, error }) => {
            const connectBtn = document.getElementById('connectBtn');
            const disconnectBtn = document.getElementById('disconnectBtn');
            
            if (connectBtn && disconnectBtn) {
                connectBtn.disabled = state === 'connected';
                disconnectBtn.disabled = state === 'disconnected';
            }
        });

        log('Application initialized');
    } catch (error) {
        log(`Initialization error: ${error.message}`, 'error');
    }
}

async function handleConnect() {
    try {
        const projectId = document.getElementById('projectId').value;
        const token = document.getElementById('token').value;

        performanceMonitor.start();
        await webRTCManager.connect(projectId, token);
    } catch (error) {
        log(`Connection failed: ${error.message}`, 'error');
        updateStatus(`Connection failed: ${error.message}`);
    }
}

async function handleDisconnect() {
    try {
        performanceMonitor.stop();
        await webRTCManager.disconnect();
    } catch (error) {
        log(`Disconnect failed: ${error.message}`, 'error');
    }
}

function handleOverlayUpdate() {
    try {
        const config = {
            text: document.getElementById('overlayText').value,
            color: document.getElementById('overlayColor').value,
            bgColor: document.getElementById('overlayBgColor').value,
            transparency: parseFloat(document.getElementById('overlayTransparency').value),
            position: document.getElementById('overlayPosition').value,
            fontSize: parseInt(document.getElementById('fontSize').value, 10)
        };

        state.updateOverlay(config);
        log('Overlay settings updated');
    } catch (error) {
        log(`Overlay update failed: ${error.message}`, 'error');
    }
}

// Initialize application when DOM is fully loaded
document.addEventListener('DOMContentLoaded', initializeApp);

// Handle page unload
window.addEventListener('beforeunload', async () => {
    if (state.connectionState === 'connected') {
        await handleDisconnect();
    }
});