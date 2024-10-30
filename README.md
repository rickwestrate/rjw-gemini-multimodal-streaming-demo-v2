
### Gemini Multimodal Streaming Demo App

**Overview**

This application demonstrates the multimodal streaming capabilities of Gemini. Currently, it supports sending video and audio to Gemini over WebRTC and receiving audio and text responses.

**Note:**

Before running the application, you need to obtain an access token by typing `gcloud auth print-access-token` in your cloud console.

**Key Components**

*   **WebRTC Connection:** The app establishes a WebRTC connection with Gemini for real-time audio/video streaming.
*   **Text Overlay:** A text overlay feature is implemented to visually send instructions or context to Gemini.
*   **State Management:** The `GeminiStreamingState` class manages the application state, including connection status and overlay settings.
*   **Video Processing:** The `VideoProcessor` class handles adding the text overlay to the video stream.
*   **Connection Management:** The `WebRTCManager` class is responsible for establishing, maintaining, and closing the WebRTC connection.

**How it Works**

1.  **Initialization**

    *   The `initializeApp` function sets up the UI, initializes the core components (`GeminiStreamingState`, `VideoProcessor`, `WebRTCManager`), and attaches event listeners to UI elements.

2.  **Connection**

    *   The `handleConnect` function retrieves the project ID and access token from the UI, disables the connect button, and initiates the connection process.
    *   The `WebRTCManager` fetches the peer connection information from Gemini, sets up the peer connection, configures the media stream (video with overlay, audio), and creates/sends the offer to establish the connection.

3.  **Video Processing**

    *   The `VideoProcessor` processes each video frame before sending it to Gemini. It adds the text overlay based on the current settings in `GeminiStreamingState`.

4.  **Text Overlay**

    *   The `handleOverlayUpdate` function updates the text overlay settings in `GeminiStreamingState` with values from the UI.

5.  **Messaging**

    *   The `handleMessage` function processes incoming messages from Gemini and displays them in the UI.

6.  **Disconnection**

    *   The `handleDisconnect` function closes the WebRTC connection, stops media tracks, and resets the application state.

**Deeper Explanation of Code Blocks**

*   `VideoProcessor.processVideoFrame`: This function handles the processing of each video frame. It draws the current frame onto an offscreen canvas, adds the text overlay if enabled, and then creates a new `VideoFrame` from the canvas for streaming.
*   `VideoProcessor.drawOverlay`: This function calculates the position of the overlay, draws a semi-transparent background, and then draws the text on top. It also includes logic for wrapping text and caching wrapped results.
*   `WebRTCManager.connect`: This function orchestrates the WebRTC connection setup. It fetches the necessary configuration from Gemini, sets up the peer connection, adds media tracks, and handles offer/answer exchange.
*   `WebRTCManager.handleMessage`: This function processes incoming messages from Gemini. It parses the message content and type (transcript, response, or system) and displays it in the UI with a timestamp.
OK, here's a deeper dive into the code, with a detailed analysis of the key functions:

### `VideoProcessor.processVideoFrame`

This function is the heart of the video processing pipeline. It takes a `VideoFrame` as input and performs the following steps:

1.  **Draw the frame onto a canvas**:
    
    ```js
    processingContext.drawImage(frame, 0, 0);
    ```
    
    This line draws the incoming video frame onto the offscreen canvas. The `drawImage` method is a standard canvas API function that copies the image data from the `VideoFrame` to the canvas context.

2.  **Add the text overlay**:
    
    ```js
    if (overlayConfig.text) {
        await this.drawOverlay(processingContext, frame.displayWidth, frame.displayHeight);
    }
    ```
    
    If the `overlayConfig.text` property is set (i.e., the user has entered overlay text), the `drawOverlay` function is called to add the text to the canvas. This function handles the positioning, formatting, and drawing of the text overlay.

3.  **Create a new `VideoFrame`**:
    
    ```js
    const newFrame = new VideoFrame(processingCanvas, {
        timestamp: frame.timestamp,
        duration: frame.duration
    });
    ```
    
    A new `VideoFrame` is created from the modified canvas. This new frame includes the original video content and the added text overlay. The timestamp and duration from the original frame are preserved to maintain synchronization.

4.  **Enqueue the new frame**:
    
    ```js
    controller.enqueue(newFrame);
    ```
    
    The new `VideoFrame` is enqueued into the `TransformStream` controller. This sends the processed frame to the next stage in the pipeline, which is the `MediaStreamTrackGenerator`.

### `VideoProcessor.drawOverlay`

This function is responsible for drawing the text overlay on the canvas. It performs the following steps:

1.  **Calculate the overlay position**:
    
    ```js
    const [x, y] = this.calculateOverlayPosition(
        position,
        width,
        height,
        boxWidth,
        boxHeight
    );
    ```
    
    The position of the overlay is calculated based on the user's selected position (`top-left`, `top-right`, etc.), the dimensions of the canvas, and the size of the text box.

2.  **Draw the background**:
    
    ```js
    ctx.globalAlpha = transparency;
    ctx.fillStyle = bgColor;
    ctx.fillRect(x, y, boxWidth, boxHeight);
    ```
    
    A semi-transparent background rectangle is drawn behind the text to improve readability. The `globalAlpha` property controls the transparency, and `fillRect` draws the rectangle.

3.  **Draw the text**:
    
    ```js
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.font = `${fontSize}px Arial`;
    ctx.textBaseline = "top";
    lines.forEach((line, i) => {
        ctx.fillText(
            line,
            x + boxPadding,
            y + boxPadding + lineHeight * i
        );
    });
    ```
    
    The text is drawn on top of the background. The `fillText` method draws each line of text, and the `forEach` loop iterates over the lines (which may have been wrapped if the text is too long).

### `WebRTCManager.connect`

This function handles the setup of the WebRTC connection to Gemini. It performs the following steps:

1.  **Fetch peer connection information**:
    
    ```js
    const serverConfig = await this.fetchPeerConnectionInfo(endpoint, token);
    ```
    
    It fetches the necessary configuration for the WebRTC connection from Gemini. This includes ICE servers and other settings.

2.  **Set up the peer connection**:
    
    ```js
    await this.setupPeerConnection(serverConfig);
    ```
    
    A new `RTCPeerConnection` is created using the fetched configuration. Event listeners are attached to handle ICE candidate gathering, connection state changes, and data channel events.

3.  **Set up the media stream**:
    
    ```js
    await this.setupMediaStream();
    ```
    
    The user's camera and microphone are accessed, and the video stream is processed to add the text overlay. The processed stream is then added to the peer connection.

4.  **Create and send the offer**:
    
    ```js
    await this.createAndSendOffer(endpoint, token);
    ```
    
    An offer is created and sent to Gemini to initiate the WebRTC connection. This includes the local session description (SDP) that describes the media capabilities and preferences of the client.

### `WebRTCManager.handleMessage`

This function processes incoming messages from Gemini. It performs the following steps:

1.  **Decode the message**:
    
    ```js
    const text = new TextDecoder().decode(event.data);
    ```
    
    The message is decoded from the raw binary data received from the data channel.

2.  **Parse the message type**:
    
    ```js
    let messageType = "system";
    let content = text;
    
    if (text.startsWith("Transcript:")) {
        messageType = "user";
        content = text.substring("Transcript:".length).trim();
    } else if (text.startsWith("Response:")) {
        messageType = "ai";
        content = text.substring("Response:".length).trim();
    }
    ```
    
    The message type (transcript, response, or system) is determined based on the prefix of the message. The content is extracted by removing the prefix.

3.  **Display the message**:
    
    ```js
    const responseElement = document.getElementById("response");
    // ... (Create message elements) ...
    responseElement.appendChild(wrapper);
    responseElement.scrollTop = responseElement.scrollHeight;
    ```
    
    The message is displayed in the UI with a timestamp. The `responseElement` is the container for the conversation history.
