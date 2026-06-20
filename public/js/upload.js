/*
 * upload.js — chunked tape uploads for the admin dashboard.
 *
 * Large videos can't be sent in a single multipart POST: the deployment sits
 * behind a proxy (Cloudflare Tunnels) that rejects any HTTP request body over
 * 100 MB with "413 Payload Too Large". So instead of one big request we slice
 * the file in the browser and stream it as a sequence of small ones:
 *
 *     POST   .../uploads                      -> { uploadId }
 *     PUT    .../uploads/:id/chunks/:index    -> one CHUNK_SIZE slice
 *     POST   .../uploads/:id/complete         -> assemble + save, { redirect }
 *
 * Each request stays comfortably below the cap, and we show a live progress
 * bar while the chunks go up.
 */
(function () {
  "use strict";

  // Slice size. Kept well under the proxy's 100 MB hard limit (and the 50 MB
  // server-side per-chunk guard) so a chunk plus its headers is never close.
  var CHUNK_SIZE = 25 * 1024 * 1024; // 25 MB

  var form = document.getElementById("uploadForm");
  if (!form) return;

  var base = form.dataset.base; // e.g. /admin/libraries/3
  var fileInput = form.querySelector('input[type="file"]');
  var titleInput = document.getElementById("tapeTitle");
  var descInput = document.getElementById("tapeDesc");
  var btn = document.getElementById("uploadBtn");

  var progress = document.getElementById("uploadProgress");
  var bar = document.getElementById("uploadBar");
  var status = document.getElementById("uploadStatus");
  var errorBox = document.getElementById("uploadError");

  function showError(msg) {
    if (!errorBox) return window.alert(msg);
    errorBox.textContent = msg;
    errorBox.classList.remove("hidden");
  }

  function setProgress(done, total, label) {
    if (progress) progress.classList.remove("hidden");
    var pct = total > 0 ? Math.round((done / total) * 100) : 0;
    if (bar) bar.style.width = pct + "%";
    if (status) status.textContent = label || pct + "% — chunk " + done + " of " + total;
  }

  // Parse a fetch Response as JSON, turning auth redirects / non-JSON bodies
  // (e.g. requireAdmin bouncing us to the login page) into a clear error.
  function asJson(res) {
    var type = res.headers.get("content-type") || "";
    if (res.redirected || type.indexOf("application/json") === -1) {
      throw new Error("Your session expired — please log in again.");
    }
    return res.json().then(function (body) {
      if (!res.ok) throw new Error(body.error || "Upload failed.");
      return body;
    });
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (errorBox) errorBox.classList.add("hidden");

    var file = fileInput && fileInput.files && fileInput.files[0];
    if (!file) return showError("Choose a video file first.");

    var totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));

    if (btn) btn.disabled = true;
    setProgress(0, totalChunks, "Preparing upload…");

    // 1. Open a session.
    fetch(base + "/uploads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: file.name,
        mimeType: file.type || "",
        fileSize: file.size,
        totalChunks: totalChunks,
      }),
    })
      .then(asJson)
      .then(function (init) {
        var uploadId = init.uploadId;

        // 2. Send each chunk in order.
        var sendChunk = function (i) {
          if (i >= totalChunks) return uploadId;
          var start = i * CHUNK_SIZE;
          var slice = file.slice(start, start + CHUNK_SIZE);
          return fetch(base + "/uploads/" + uploadId + "/chunks/" + i, {
            method: "PUT",
            headers: { "Content-Type": "application/octet-stream" },
            body: slice,
          })
            .then(asJson)
            .then(function (p) {
              setProgress(p.received, p.totalChunks);
              return sendChunk(i + 1);
            });
        };

        return sendChunk(0);
      })
      .then(function (uploadId) {
        // 3. Finalise with the tape's metadata.
        setProgress(totalChunks, totalChunks, "Finalising tape…");
        return fetch(base + "/uploads/" + uploadId + "/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: titleInput ? titleInput.value : "",
            description: descInput ? descInput.value : "",
          }),
        }).then(asJson);
      })
      .then(function (done) {
        window.location.href = done.redirect || base.replace(/\/libraries\/.*/, "");
      })
      .catch(function (err) {
        if (btn) btn.disabled = false;
        if (progress) progress.classList.add("hidden");
        showError(err.message || "Upload failed.");
      });
  });
})();
