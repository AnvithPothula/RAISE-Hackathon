package com.pythos.remote;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

final class PythosClient {
    private final String baseUrl;

    PythosClient(String baseUrl) {
        this.baseUrl = normalizeBaseUrl(baseUrl);
    }

    static String normalizeBaseUrl(String rawValue) {
        String value = rawValue == null ? "" : rawValue.trim();
        if (value.isEmpty()) {
            return "";
        }
        if (!value.contains("://")) {
            value = "http://" + value;
        }
        try {
            URL url = new URL(value);
            String protocol = url.getProtocol();
            if (!"http".equals(protocol) && !"https".equals(protocol)) {
                throw new IllegalArgumentException("Use an http or https server URL.");
            }
            String host = url.getHost();
            if (host == null || host.trim().isEmpty()) {
                throw new IllegalArgumentException("Server URL is missing a host.");
            }
            int port = url.getPort() > 0 ? url.getPort() : 9000;
            return protocol + "://" + bracketIpv6Host(host) + ":" + port;
        } catch (Exception error) {
            throw new IllegalArgumentException("Server URL should look like http://100.102.158.14:9000.", error);
        }
    }

    JSONObject health() throws Exception {
        HttpURLConnection connection = open("/health", "GET", null);
        return readJson(connection);
    }

    void sendDeviceEvent(String type, String deviceId, String sessionId, String deviceName) throws Exception {
        JSONObject body = new JSONObject()
            .put("type", type)
            .put("deviceId", deviceId)
            .put("sessionId", sessionId)
            .put("deviceName", deviceName);
        HttpURLConnection connection = open("/api/device/event", "POST", "application/json; charset=utf-8");
        writeBytes(connection, body.toString().getBytes(StandardCharsets.UTF_8));
        readJson(connection);
    }

    RemoteResponse sendText(String text, String deviceId, String sessionId, String deviceName) throws Exception {
        JSONObject body = new JSONObject()
            .put("text", text)
            .put("deviceId", deviceId)
            .put("sessionId", sessionId)
            .put("deviceName", deviceName);
        HttpURLConnection connection = open("/api/text/request", "POST", "application/json; charset=utf-8");
        writeBytes(connection, body.toString().getBytes(StandardCharsets.UTF_8));
        return parseRemoteResponse(readJson(connection));
    }

    RemoteResponse uploadAudio(File wavFile, String deviceId, String sessionId, String deviceName) throws Exception {
        String boundary = "PythosRemote-" + System.currentTimeMillis();
        HttpURLConnection connection = open("/api/audio/request", "POST", "multipart/form-data; boundary=" + boundary);
        connection.setDoOutput(true);
        try (OutputStream output = connection.getOutputStream()) {
            writeField(output, boundary, "deviceId", deviceId);
            writeField(output, boundary, "sessionId", sessionId);
            writeField(output, boundary, "deviceName", deviceName);
            writeFile(output, boundary, "file", wavFile);
            output.write(("--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));
        }
        return parseRemoteResponse(readJson(connection));
    }

    String absoluteUrl(String maybeUrl) {
        String value = maybeUrl == null ? "" : maybeUrl.trim();
        if (value.startsWith("http://") || value.startsWith("https://")) {
            return value;
        }
        if (value.startsWith("/")) {
            return baseUrl + value;
        }
        return value.isEmpty() ? "" : baseUrl + "/" + value;
    }

    private HttpURLConnection open(String path, String method, String contentType) throws IOException {
        if (baseUrl.isEmpty()) {
            throw new IOException("Set the Pythos server URL first.");
        }
        HttpURLConnection connection = (HttpURLConnection) new URL(baseUrl + path).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(10000);
        connection.setReadTimeout(180000);
        connection.setUseCaches(false);
        connection.setRequestProperty("Accept", "application/json");
        if (contentType != null) {
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", contentType);
        }
        return connection;
    }

    private static void writeBytes(HttpURLConnection connection, byte[] bytes) throws IOException {
        connection.setFixedLengthStreamingMode(bytes.length);
        try (OutputStream output = connection.getOutputStream()) {
            output.write(bytes);
        }
    }

    private static void writeField(OutputStream output, String boundary, String name, String value) throws IOException {
        output.write(("--" + boundary + "\r\n").getBytes(StandardCharsets.UTF_8));
        output.write(("Content-Disposition: form-data; name=\"" + name + "\"\r\n\r\n").getBytes(StandardCharsets.UTF_8));
        output.write((value == null ? "" : value).getBytes(StandardCharsets.UTF_8));
        output.write("\r\n".getBytes(StandardCharsets.UTF_8));
    }

    private static void writeFile(OutputStream output, String boundary, String name, File file) throws IOException {
        output.write(("--" + boundary + "\r\n").getBytes(StandardCharsets.UTF_8));
        output.write(("Content-Disposition: form-data; name=\"" + name + "\"; filename=\"prompt.wav\"\r\n").getBytes(StandardCharsets.UTF_8));
        output.write("Content-Type: audio/wav\r\n\r\n".getBytes(StandardCharsets.UTF_8));
        byte[] buffer = new byte[16384];
        try (FileInputStream input = new FileInputStream(file)) {
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
            }
        }
        output.write("\r\n".getBytes(StandardCharsets.UTF_8));
    }

    private static JSONObject readJson(HttpURLConnection connection) throws Exception {
        int code = connection.getResponseCode();
        InputStream stream = code >= 200 && code < 300 ? connection.getInputStream() : connection.getErrorStream();
        String text = readText(stream);
        if (code < 200 || code >= 300) {
            throw new IOException(text.isEmpty() ? "HTTP " + code : text);
        }
        return text.isEmpty() ? new JSONObject() : new JSONObject(text);
    }

    private static String readText(InputStream stream) throws IOException {
        if (stream == null) {
            return "";
        }
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int read;
        while ((read = stream.read(buffer)) != -1) {
            output.write(buffer, 0, read);
        }
        return output.toString(StandardCharsets.UTF_8.name());
    }

    private static RemoteResponse parseRemoteResponse(JSONObject json) {
        String audio = json.optString("audioUrl", json.optString("fileUrl", ""));
        return new RemoteResponse(json.optString("text", ""), audio, json.optBoolean("toolUsed", false));
    }

    private static String bracketIpv6Host(String host) {
        if (host.contains(":") && !host.startsWith("[") && !host.endsWith("]")) {
            return "[" + host + "]";
        }
        return host;
    }
}
