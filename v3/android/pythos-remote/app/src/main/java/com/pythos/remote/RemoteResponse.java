package com.pythos.remote;

final class RemoteResponse {
    final String text;
    final String audioUrl;
    final boolean toolUsed;

    RemoteResponse(String text, String audioUrl, boolean toolUsed) {
        this.text = text == null ? "" : text;
        this.audioUrl = audioUrl == null ? "" : audioUrl;
        this.toolUsed = toolUsed;
    }
}
