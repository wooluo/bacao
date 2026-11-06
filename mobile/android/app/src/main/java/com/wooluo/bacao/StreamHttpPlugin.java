package com.wooluo.bacao;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.Headers;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * SSE 流式 HTTP 插件：原生 OkHttp 直连（无 WebView CORS 限制），
 * 把上游 data: 行以 stream-http-data 事件逐条回抛给 JS，用于 AI 判定流式输出。
 */
@CapacitorPlugin(name = "StreamHttp")
public class StreamHttpPlugin extends Plugin {
    private static final Map<String, Call> ACTIVE = new ConcurrentHashMap<>();
    private OkHttpClient client;

    private synchronized OkHttpClient client() {
        if (client == null) {
            client = new OkHttpClient.Builder()
                    .connectTimeout(30, TimeUnit.SECONDS)
                    .writeTimeout(60, TimeUnit.SECONDS)
                    .readTimeout(300, TimeUnit.SECONDS)
                    .build();
        }
        return client;
    }

    @PluginMethod
    public void request(final PluginCall call) {
        final String id = call.getString("id", "");
        String url = call.getString("url", "");
        String body = call.getString("body", "{}");
        JSObject headersObj = call.getObject("headers");

        Headers.Builder hb = new Headers.Builder();
        if (headersObj != null) {
            Iterator<String> keys = headersObj.keys();
            while (keys.hasNext()) {
                String k = keys.next();
                hb.set(k, headersObj.optString(k, ""));
            }
        }

        Request request;
        try {
            request = new Request.Builder()
                    .url(url)
                    .headers(hb.build())
                    .post(RequestBody.create(body, MediaType.parse("application/json; charset=utf-8")))
                    .build();
        } catch (IllegalArgumentException e) {
            call.reject("地址无效：" + e.getMessage());
            return;
        }

        Call okCall = client().newCall(request);
        ACTIVE.put(id, okCall);
        okCall.enqueue(new Callback() {
            @Override
            public void onFailure(Call c, IOException e) {
                ACTIVE.remove(id);
                if (c.isCanceled()) {
                    // 用户主动停止：按正常结束处理，JS 侧保留已生成部分
                    emit(id, "stream-http-end", null);
                } else {
                    JSObject err = new JSObject();
                    err.put("message", "连接失败：" + e.getMessage());
                    emit(id, "stream-http-error", err);
                }
            }

            @Override
            public void onResponse(Call c, Response resp) throws IOException {
                try {
                    ResponseBody rb = resp.body();
                    if (!resp.isSuccessful()) {
                        String errBody = rb == null ? "" : rb.string();
                        JSObject err = new JSObject();
                        String snippet = errBody.length() > 300 ? errBody.substring(0, 300) : errBody;
                        err.put("message", "HTTP " + resp.code() + "：" + snippet);
                        emit(id, "stream-http-error", err);
                        return;
                    }
                    BufferedReader reader = new BufferedReader(
                            new InputStreamReader(rb.byteStream(), StandardCharsets.UTF_8));
                    String line;
                    while ((line = reader.readLine()) != null) {
                        line = line.trim();
                        if (!line.startsWith("data:")) continue;
                        JSObject ev = new JSObject();
                        ev.put("payload", line.substring(5).trim());
                        emit(id, "stream-http-data", ev);
                    }
                    emit(id, "stream-http-end", null);
                } catch (IOException e) {
                    if (c.isCanceled()) {
                        emit(id, "stream-http-end", null);
                    } else {
                        JSObject err = new JSObject();
                        err.put("message", "流中断：" + e.getMessage());
                        emit(id, "stream-http-error", err);
                    }
                } finally {
                    ACTIVE.remove(id);
                    if (resp.body() != null) resp.body().close();
                }
            }
        });
        call.resolve();
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String id = call.getString("id", "");
        Call c = ACTIVE.remove(id);
        if (c != null) c.cancel();
        call.resolve();
    }

    private void emit(String id, String event, JSObject data) {
        JSObject payload = data == null ? new JSObject() : data;
        try {
            payload.put("id", id);
        } catch (Exception ignored) {
        }
        notifyListeners(event, payload);
    }
}
