package com.pythos.remote;

import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;

import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;

final class WavRecorder {
    static final int SAMPLE_RATE = 16000;

    private AudioRecord audioRecord;
    private Thread thread;
    private RandomAccessFile output;
    private volatile boolean recording;
    private volatile IOException recordError;
    private long pcmBytes;

    synchronized void start(File file) throws IOException {
        if (recording) {
            throw new IOException("Recording is already running.");
        }

        int minBuffer = AudioRecord.getMinBufferSize(
            SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT
        );
        if (minBuffer <= 0) {
            throw new IOException("This phone cannot record 16 kHz mono PCM audio.");
        }
        int bufferSize = Math.max(minBuffer, SAMPLE_RATE / 5);

        output = new RandomAccessFile(file, "rw");
        output.setLength(0);
        writeHeader(output, 0);
        pcmBytes = 0;
        recordError = null;

        try {
            audioRecord = new AudioRecord(
                MediaRecorder.AudioSource.VOICE_RECOGNITION,
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                bufferSize
            );
        } catch (RuntimeException error) {
            closeOutput();
            throw new IOException("Microphone initialization failed.", error);
        }
        if (audioRecord.getState() != AudioRecord.STATE_INITIALIZED) {
            closeOutput();
            audioRecord.release();
            audioRecord = null;
            throw new IOException("Microphone initialization failed.");
        }

        recording = true;
        try {
            audioRecord.startRecording();
        } catch (RuntimeException error) {
            recording = false;
            closeOutput();
            audioRecord.release();
            audioRecord = null;
            throw new IOException("Microphone could not start recording.", error);
        }
        byte[] buffer = new byte[bufferSize];
        thread = new Thread(() -> recordLoop(buffer), "pythos-wav-recorder");
        thread.start();
    }

    synchronized void stop() throws IOException {
        if (!recording) {
            return;
        }
        recording = false;
        AudioRecord localRecord = audioRecord;
        if (localRecord != null) {
            try {
                localRecord.stop();
            } catch (IllegalStateException ignored) {
                // The record loop may have already stopped after an audio error.
            }
        }
        Thread localThread = thread;
        if (localThread != null) {
            try {
                localThread.join(1500);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
        }
        if (output != null) {
            output.seek(0);
            writeHeader(output, pcmBytes);
        }
        closeOutput();
        if (localRecord != null) {
            localRecord.release();
        }
        audioRecord = null;
        thread = null;
        if (recordError != null) {
            throw recordError;
        }
    }

    synchronized boolean isRecording() {
        return recording;
    }

    private void recordLoop(byte[] buffer) {
        AudioRecord localRecord = audioRecord;
        RandomAccessFile localOutput = output;
        if (localRecord == null || localOutput == null) {
            return;
        }
        while (recording) {
            int read = localRecord.read(buffer, 0, buffer.length);
            if (read > 0) {
                try {
                    localOutput.write(buffer, 0, read);
                    pcmBytes += read;
                } catch (IOException error) {
                    recordError = error;
                    recording = false;
                }
            } else if (read < 0) {
                recordError = new IOException("Microphone read failed with code " + read + ".");
                recording = false;
            }
        }
    }

    private void closeOutput() throws IOException {
        if (output != null) {
            output.close();
            output = null;
        }
    }

    private static void writeHeader(RandomAccessFile file, long dataBytes) throws IOException {
        file.writeBytes("RIFF");
        writeIntLE(file, 36 + dataBytes);
        file.writeBytes("WAVE");
        file.writeBytes("fmt ");
        writeIntLE(file, 16);
        writeShortLE(file, 1);
        writeShortLE(file, 1);
        writeIntLE(file, SAMPLE_RATE);
        writeIntLE(file, SAMPLE_RATE * 2);
        writeShortLE(file, 2);
        writeShortLE(file, 16);
        file.writeBytes("data");
        writeIntLE(file, dataBytes);
    }

    private static void writeIntLE(RandomAccessFile file, long value) throws IOException {
        file.write((int) (value & 0xff));
        file.write((int) ((value >> 8) & 0xff));
        file.write((int) ((value >> 16) & 0xff));
        file.write((int) ((value >> 24) & 0xff));
    }

    private static void writeShortLE(RandomAccessFile file, int value) throws IOException {
        file.write(value & 0xff);
        file.write((value >> 8) & 0xff);
    }
}
