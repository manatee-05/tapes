/*
 * player.js — the virtual VCR transport logic.
 *
 * Drives the <video> element via custom VCR buttons. Crucially, no visual
 * filter is ever applied to the video: the only thing we toggle on the screen
 * is whether the EMPTY-state overlays are shown. The "tracking" control is a
 * simulated effect applied to the bezel/frame, never to the video pixels.
 */
(function () {
  "use strict";

  var video = document.getElementById("tape");
  var screen = document.getElementById("screen");
  var bezel = document.getElementById("bezel");
  var standby = document.getElementById("standby");

  var timer = document.getElementById("timer");
  var statusEl = document.getElementById("status");
  var seek = document.getElementById("seek");
  var curEl = document.getElementById("cur");
  var durEl = document.getElementById("dur");

  if (!video) return;

  var scrubInterval = null; // active REW/FF fast-scrub timer

  /* ---- helpers ---- */
  function pad(n) { return String(Math.floor(n)).padStart(2, "0"); }
  function fmt(t) {
    if (!isFinite(t)) t = 0;
    var h = Math.floor(t / 3600);
    var m = Math.floor((t % 3600) / 60);
    var s = Math.floor(t % 60);
    return (h > 0 ? pad(h) + ":" : "") + pad(m) + ":" + pad(s);
  }
  function setStatus(text) { statusEl.textContent = text; }

  // Show the empty-state overlays (standby/static). Used by STOP.
  function showStandby(label) {
    screen.classList.remove("playing");
    standby.style.display = "flex";
    standby.querySelector(".digital").textContent = label || "■ STANDBY ■";
  }
  // Hide overlays — the pristine video is on screen.
  function hideStandby() {
    screen.classList.add("playing");
    standby.style.display = "none";
  }

  function stopScrub() {
    if (scrubInterval) { clearInterval(scrubInterval); scrubInterval = null; }
  }

  // Fast-scrub in a direction (+1 = FF, -1 = REW) by nudging currentTime.
  function startScrub(direction) {
    stopScrub();
    video.pause();
    setStatus(direction > 0 ? "▶▶ FF" : "◀◀ REW");
    hideStandby();
    scrubInterval = setInterval(function () {
      var next = video.currentTime + direction * 1.5; // ~5x perceived speed
      if (next <= 0) { video.currentTime = 0; stopScrub(); setStatus("STOPPED"); }
      else if (next >= video.duration) { video.currentTime = video.duration; stopScrub(); video.pause(); }
      else { video.currentTime = next; }
    }, 120);
  }

  /* ---- transport buttons ---- */
  document.getElementById("btnPlay").addEventListener("click", function () {
    stopScrub();
    hideStandby();
    video.play();
  });
  document.getElementById("btnPause").addEventListener("click", function () {
    stopScrub();
    video.pause();
    setStatus("PAUSED");
  });
  document.getElementById("btnStop").addEventListener("click", function () {
    stopScrub();
    video.pause();
    video.currentTime = 0;
    setStatus("STOPPED");
    showStandby("■ STOPPED ■");
  });
  document.getElementById("btnRew").addEventListener("click", function () {
    // Toggle: if already rewinding, stop; else start.
    if (scrubInterval) { stopScrub(); video.pause(); setStatus("PAUSED"); }
    else startScrub(-1);
  });
  document.getElementById("btnFf").addEventListener("click", function () {
    if (scrubInterval) { stopScrub(); video.pause(); setStatus("PAUSED"); }
    else startScrub(1);
  });
  document.getElementById("btnEject").addEventListener("click", function () {
    // Eject pops the tape out and returns to the shelf, i.e. the current
    // URL with the trailing "/watch/:id" stripped off.
    window.location.href = window.location.pathname.replace(/\/watch\/.*$/, "");
  });

  /* ---- video element events ---- */
  video.addEventListener("play", function () { hideStandby(); setStatus("▶ PLAY"); });
  video.addEventListener("playing", function () { hideStandby(); setStatus("▶ PLAY"); });
  video.addEventListener("pause", function () {
    if (!scrubInterval && video.currentTime > 0 && video.currentTime < video.duration) {
      setStatus("PAUSED");
    }
  });
  video.addEventListener("ended", function () {
    setStatus("END OF TAPE");
    showStandby("▮ END OF TAPE ▮");
  });
  video.addEventListener("loadedmetadata", function () {
    durEl.textContent = fmt(video.duration);
  });
  video.addEventListener("timeupdate", function () {
    timer.textContent = fmt(video.currentTime);
    curEl.textContent = fmt(video.currentTime);
    if (video.duration) {
      seek.value = String((video.currentTime / video.duration) * 1000);
    }
  });

  /* ---- seek bar ---- */
  seek.addEventListener("input", function () {
    if (video.duration) {
      video.currentTime = (seek.value / 1000) * video.duration;
    }
  });

  /* ---- auxiliary controls ---- */
  document.getElementById("speed").addEventListener("change", function (e) {
    video.playbackRate = parseFloat(e.target.value);
  });
  document.getElementById("volume").addEventListener("input", function (e) {
    video.volume = parseInt(e.target.value, 10) / 100;
  });

  // Simulated TRACKING: distorts the BEZEL/frame only, never the video.
  // The further the slider from centre, the stronger the frame jitter.
  document.getElementById("tracking").addEventListener("input", function (e) {
    var v = Math.abs(parseInt(e.target.value, 10));
    if (v > 6) {
      bezel.classList.add("tracking-jitter");
      bezel.style.animationDuration = (0.22 - v / 400) + "s";
    } else {
      bezel.classList.remove("tracking-jitter");
    }
  });
})();
