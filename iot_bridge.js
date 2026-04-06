/* ================================================================
   IoT Bridge для RoboScratch  v3.0
   ─────────────────────────────────────────────────────────────────
   Hub  (ПК / Android) : Bluetooth + MQTT publisher
   Remote (iPhone / etc): MQTT subscriber + плавний інтерполятор
   ─────────────────────────────────────────────────────────────────
   Що нового v3:
   • Виправлено блокування Scratch при відсутності BT
   • Плавний інтерполятор на Hub-стороні (EMA smoother)
   • Instant-stop: при l=0,r=0 зупинка миттєва без інертності
   • Remote шле stop без throttle, рух — кожні 35мс
   • Room Code для синхронізації між пристроями
   • MQTT retain=true для статусу, retain=false для drive
   ================================================================ */
(function () {
  'use strict';

  /* ──────────────────────────────────────────────
     Константи
  ────────────────────────────────────────────── */
  const HAS_BLUETOOTH = !!(navigator && navigator.bluetooth);
  const IS_IOS        = /iPhone|iPad|iPod/i.test(navigator.userAgent || '');
  const PREFIX_KEY    = 'roboscratch_iot_prefix';
  const MQTT_URL      = 'wss://broker.hivemq.com:8884/mqtt';

  /* Інтерполятор: скільки тіків (по TICKER_MS) займає вирівнювання до нового значення.
     0 = миттєво (тільки для stop), більше = плавніше але повільніша реакція */
  const TICKER_MS       = 25;   // внутрішній тік Hub-інтерполятора (мс)
  const SMOOTH_TICKS    = 3;    // скільки тіків їдемо до нового таргету (рух)
  const HOLD_TIMEOUT_MS = 280;  // якщо Remote мовчить X мс → стоп
  const REMOTE_THROTTLE = 35;   // мін. інтервал між drive-пакетами на Remote (мс)

  /* ──────────────────────────────────────────────
     Стан
  ────────────────────────────────────────────── */
  let UNIQUE_PREFIX  = getOrCreatePrefix();
  let TOPIC_ROOT     = buildRoot(UNIQUE_PREFIX);
  let TOPIC_STATUS   = TOPIC_ROOT + '/status';
  let TOPIC_CONTROL  = TOPIC_ROOT + '/control/';

  let mqttClient    = null;
  let mqttConnected = false;
  let mode          = null;   // 'hub' | 'remote'
  let hubDevices    = [];
  let selectedRemoteId = null;
  let statusTimer   = null;
  let lastDrivePublish = 0;
  const lastRemoteById = {};

  /* Hub smoother state */
  const current  = { l: 0, r: 0, m3: 0, m4: 0 };  // поточні значення що реально шлемо
  const target   = { l: 0, r: 0, m3: 0, m4: 0 };  // цільові значення від Remote
  let   ticksLeft    = 0;    // скільки ще тіків інтерполюємо
  let   smoothTimer  = null; // setInterval інтерполятора
  let   lastPacketTs = 0;    // коли прийшов останній пакет від Remote

  /* ──────────────────────────────────────────────
     DOM refs
  ────────────────────────────────────────────── */
  const elBtActionRow   = document.getElementById('btActionRow');
  const elIotBigBtn     = document.getElementById('iotBigBtn');
  const elBtScanText    = document.getElementById('btScanText');
  const elBtStatusDot   = document.getElementById('btStatusDot');
  const elMqttStatusDot = document.getElementById('mqttStatusDot');
  const elIotDeviceList = document.getElementById('iotDeviceList');
  const elIotHubList    = document.getElementById('iotHubList');
  const elBtDeviceList  = document.getElementById('btDeviceList');
  const elIotBackBtn    = document.getElementById('iotBackBtn');
  const elHubModal      = document.getElementById('iotHubModal');
  const elHubModalList  = document.getElementById('iotHubModalList');
  const elHubSummary    = document.getElementById('iotHubSummary');
  const elHubSub        = document.getElementById('iotHubModalSub');

  /* ══════════════════════════════════════════════
     ROOM CODE
  ══════════════════════════════════════════════ */

  function buildRoot(prefix) { return prefix + '/hub_1'; }

  function getOrCreatePrefix() {
    try {
      const ex = localStorage.getItem(PREFIX_KEY);
      if (ex) return ex;
      const id = 'roboscratch_v1_' + Math.random().toString(36).slice(2, 8);
      localStorage.setItem(PREFIX_KEY, id);
      return id;
    } catch (e) { return 'roboscratch_v1_fallback'; }
  }

  function extractRoomCode(prefix) {
    const parts = prefix.split('_');
    return parts[parts.length - 1].toUpperCase();
  }

  function applyRoomCode(code) {
    code = String(code).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
    if (!code) return;
    const newPrefix = 'roboscratch_v1_' + code;
    try { localStorage.setItem(PREFIX_KEY, newPrefix); } catch (e) {}
    UNIQUE_PREFIX = newPrefix;
    TOPIC_ROOT    = buildRoot(UNIQUE_PREFIX);
    TOPIC_STATUS  = TOPIC_ROOT + '/status';
    TOPIC_CONTROL = TOPIC_ROOT + '/control/';
    if (mqttClient) {
      try { mqttClient.end(true); } catch (e) {}
      mqttClient    = null;
      mqttConnected = false;
      setDot(elMqttStatusDot, false);
    }
    ensureMqtt();
    updateRoomCodeUI();
  }

  function updateRoomCodeUI() {
    const el = document.getElementById('iotRoomCodeDisplay');
    if (el) el.textContent = extractRoomCode(UNIQUE_PREFIX);
    const inp = document.getElementById('iotRemoteCodeInput');
    if (inp && !inp.dataset.userEdited) inp.value = extractRoomCode(UNIQUE_PREFIX);
  }

  /* ══════════════════════════════════════════════
     MQTT
  ══════════════════════════════════════════════ */

  function setDot(el, ok) {
    if (!el) return;
    el.classList.remove('bg-red-500', 'bg-green-500');
    el.classList.add(ok ? 'bg-green-500' : 'bg-red-500');
  }

  function ensureMqtt() {
    if (mqttClient || !window.mqtt) return;
    const clientId = UNIQUE_PREFIX + '_' + Math.random().toString(16).slice(2, 6);
    mqttClient = window.mqtt.connect(MQTT_URL, {
      clientId,
      reconnectPeriod : 2000,
      keepalive       : 20,
      clean           : true,
    });
    mqttClient.on('connect', function () {
      mqttConnected = true;
      setDot(elMqttStatusDot, true);
      if (mode === 'hub')    subscribeHub();
      if (mode === 'remote') subscribeRemote();
    });
    mqttClient.on('close', function () { mqttConnected = false; setDot(elMqttStatusDot, false); });
    mqttClient.on('error', function () { mqttConnected = false; setDot(elMqttStatusDot, false); });
    mqttClient.on('message', handleMqttMessage);
  }

  function subscribeHub()    { if (mqttClient) mqttClient.subscribe(TOPIC_CONTROL + '+'); }
  function subscribeRemote() { if (mqttClient) mqttClient.subscribe(TOPIC_STATUS); }

  function publishStatus() {
    if (!mqttClient || !mqttConnected) return;
    mqttClient.publish(TOPIC_STATUS,
      JSON.stringify({ devices: hubDevices, ts: Date.now() }),
      { qos: 0, retain: true });
  }

  /* ══════════════════════════════════════════════
     HUB SMOOTHER (інтерполятор на стороні Hub)
     ─────────────────────────────────────────────
     Кожні TICKER_MS мс перераховуємо поточні значення
     моторів і шлемо BLE-пакет.

     Рух   → плавно наближаємося до target за SMOOTH_TICKS тіків
     Стоп  → МИТТЄВО обнуляємо і зупиняємо таймер
     Timeout → якщо Remote замовк на HOLD_TIMEOUT_MS → стоп
  ══════════════════════════════════════════════ */

  function startSmoother() {
    if (smoothTimer) return;
    smoothTimer = setInterval(smootherTick, TICKER_MS);
  }

  function stopSmoother() {
    if (smoothTimer) { clearInterval(smoothTimer); smoothTimer = null; }
    current.l = current.r = current.m3 = current.m4 = 0;
    target.l  = target.r  = target.m3  = target.m4  = 0;
    ticksLeft = 0;
  }

  function smootherTick() {
    /* Timeout: Remote мовчить */
    if (lastPacketTs > 0 && Date.now() - lastPacketTs > HOLD_TIMEOUT_MS) {
      /* Плавне гальмування до нуля за кілька тіків */
      target.l = target.r = target.m3 = target.m4 = 0;
      ticksLeft = SMOOTH_TICKS;
    }

    if (ticksLeft <= 0) {
      /* Вже досягли таргету — просто тримаємо */
      sendCurrentToBle();
      return;
    }

    /* Лінійна інтерполяція: рухаємось на 1/ticksLeft частину шляху */
    const t = 1 / ticksLeft;
    current.l  = lerp(current.l,  target.l,  t);
    current.r  = lerp(current.r,  target.r,  t);
    current.m3 = lerp(current.m3, target.m3, t);
    current.m4 = lerp(current.m4, target.m4, t);
    ticksLeft--;

    sendCurrentToBle();
  }

  function lerp(a, b, t) {
    const v = a + (b - a) * t;
    return Math.round(Math.max(-100, Math.min(100, v)));
  }

  function sendCurrentToBle() {
    if (!window.isConnected || typeof window.sendDrivePacketBLE !== 'function') return;
    window.sendDrivePacketBLE(current.l, current.r, current.m3, current.m4);
  }

  function applyTargetFromRemote(l, r, m3, m4) {
    lastPacketTs = Date.now();
    const isStop = (l === 0 && r === 0 && m3 === 0 && m4 === 0);

    if (isStop) {
      /* Миттєва зупинка */
      stopSmoother();
      if (window.isConnected && typeof window.sendDrivePacketBLE === 'function') {
        window.sendDrivePacketBLE(0, 0, 0, 0);
      }
      return;
    }

    /* Нова ціль руху */
    target.l  = l;
    target.r  = r;
    target.m3 = m3;
    target.m4 = m4;
    ticksLeft = SMOOTH_TICKS;
    startSmoother();
  }

  /* ══════════════════════════════════════════════
     RENDER
  ══════════════════════════════════════════════ */

  function renderRemoteDeviceButtons() {
    if (!elIotDeviceList) return;
    elIotDeviceList.innerHTML = '';
    if (!hubDevices.length) {
      const e = document.createElement('div');
      e.className = 'w-full px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-slate-400 text-xs';
      e.textContent = 'Немає машинок. Перевір Room Code.';
      elIotDeviceList.appendChild(e);
      elIotDeviceList.classList.remove('hidden');
      return;
    }
    elIotDeviceList.classList.remove('hidden');
    hubDevices.forEach(function (d) {
      const btn = document.createElement('button');
      btn.className = 'w-full py-2 rounded-xl border border-blue-500/30 bg-blue-500/10 text-blue-200 text-xs font-semibold';
      btn.textContent = d.name + ' (' + d.id + ')';
      if (selectedRemoteId === d.id)
        btn.style.boxShadow = 'inset 0 -12px 18px rgba(59,130,246,0.35)';
      btn.onclick = function () { selectedRemoteId = d.id; renderRemoteDeviceButtons(); };
      elIotDeviceList.appendChild(btn);
    });
  }

  function renderHubDeviceList() {
    if (!elIotHubList) return;
    elIotHubList.innerHTML = '';
    if (!hubDevices.length) {
      const e = document.createElement('div');
      e.className = 'w-full px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-slate-400 text-xs';
      e.textContent = 'Немає підключених машинок';
      elIotHubList.appendChild(e);
      elIotHubList.classList.remove('hidden');
      return;
    }
    elIotHubList.classList.remove('hidden');
    hubDevices.forEach(function (d) {
      const row   = document.createElement('div');
      row.className = 'w-full px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-slate-200 text-xs flex items-center justify-between gap-3';
      const left  = document.createElement('div');
      left.textContent = d.name + ' • ' + d.code;
      const right = document.createElement('button');
      right.className = 'px-2 py-1 rounded-lg border border-red-500/40 text-red-300 text-[10px]';
      right.textContent = 'Disconnect';
      right.onclick = function () { disconnectDevice(d.id); };
      row.appendChild(left); row.appendChild(right);
      elIotHubList.appendChild(row);
    });
  }

  function renderHubModalList() {
    if (!elHubModalList) return;
    elHubModalList.innerHTML = '';
    if (elHubSummary) elHubSummary.textContent = 'Підключено машинок: ' + hubDevices.length;
    if (elHubSub)     elHubSub.textContent = hubDevices.length
      ? 'Список активних машинок хаба' : 'Поки немає підключених машинок';

    if (!hubDevices.length) {
      const e = document.createElement('div');
      e.className = 'w-full px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-slate-400 text-xs';
      e.textContent = 'Немає підключених машинок';
      elHubModalList.appendChild(e);
      return;
    }
    const now = Date.now();
    hubDevices.forEach(function (d) {
      const row   = document.createElement('div');
      row.className = 'w-full px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-slate-200 text-xs flex items-center justify-between gap-3';
      const left  = document.createElement('div');
      const active = (now - (lastRemoteById[d.id] || 0)) < 6000;
      const dot   = document.createElement('span');
      dot.style.cssText = 'display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;background:'
        + (active ? '#22c55e' : '#ef4444');
      left.appendChild(dot);
      left.appendChild(document.createTextNode(d.name + ' • ' + d.code));
      const right = document.createElement('button');
      right.className = 'px-2 py-1 rounded-lg border border-red-500/40 text-red-300 text-[10px]';
      right.textContent = 'Disconnect';
      right.onclick = function () { disconnectDevice(d.id); };
      row.appendChild(left); row.appendChild(right);
      elHubModalList.appendChild(row);
    });
  }

  /* ══════════════════════════════════════════════
     MODES
  ══════════════════════════════════════════════ */

  function enableHubMode() {
    mode = 'hub';
    if (window._settings) {
      window._settings.iotHub = true;
      try { localStorage.setItem('rb_settings', JSON.stringify(window._settings)); } catch (e) {}
    }
    ensureMqtt();
    if (mqttConnected) subscribeHub();
    if (elBtActionRow) elBtActionRow.style.display = '';
    if (elIotBigBtn)   elIotBigBtn.classList.add('hidden');
    setDot(elBtStatusDot, !!window.isConnected);
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = setInterval(publishStatus, 4000);
    publishStatus();
    renderHubDeviceList();
    updateHubUi();
    renderHubModalList();
    updateRoomCodeUI();
  }

  function disableHubMode() {
    if (mode === 'hub') mode = null;
    stopSmoother();
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
    if (mqttClient && mqttConnected) {
      try { mqttClient.unsubscribe(TOPIC_CONTROL + '+'); } catch (e) {}
    }
  }

  function enableRemoteMode() {
    mode = 'remote';
    ensureMqtt();
    if (mqttConnected) subscribeRemote();
    if (elBtActionRow) elBtActionRow.style.display = 'none';
    if (elIotBigBtn)   elIotBigBtn.classList.remove('hidden');
    if (elBtScanText)  elBtScanText.textContent = 'Режим IoT (Remote)';
    setDot(elBtStatusDot, false);
    if (elIotHubList)  elIotHubList.classList.add('hidden');
    updateRoomCodeUI();
  }

  /* ══════════════════════════════════════════════
     BLE callbacks
  ══════════════════════════════════════════════ */

  function onBleConnected(dev) {
    setDot(elBtStatusDot, true);
    if (!dev) return;
    const id   = sanitizeId(dev.id || dev.name || 'robot');
    const name = dev.name || 'Робот';
    if (!hubDevices.find(x => x.id === id)) {
      hubDevices.push({ id, name, code: makeRobotCode(id), ref: dev });
    } else {
      const item = hubDevices.find(x => x.id === id);
      if (item && !item.ref) item.ref = dev;
    }
    if (mode === 'hub') { publishStatus(); renderHubDeviceList(); updateHubUi(); renderHubModalList(); }
  }

  function onBleDisconnected(dev) {
    setDot(elBtStatusDot, false);
    stopSmoother();
    if (!dev) return;
    const id = sanitizeId(dev.id || dev.name || 'robot');
    hubDevices = hubDevices.filter(x => x.id !== id);
    if (mode === 'hub') { publishStatus(); renderHubDeviceList(); updateHubUi(); renderHubModalList(); }
  }

  function sanitizeId(raw) {
    return String(raw || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'robot';
  }
  function makeRobotCode(id) { return 'RB-' + id.slice(-4).toUpperCase(); }

  /* ══════════════════════════════════════════════
     MQTT MESSAGES
  ══════════════════════════════════════════════ */

  function handleMqttMessage(topic, message) {
    const text = message ? message.toString() : '';

    /* Remote: отримуємо список машинок від Hub */
    if (mode === 'remote' && topic === TOPIC_STATUS) {
      try {
        const data = JSON.parse(text);
        hubDevices = Array.isArray(data.devices) ? data.devices : [];
        if (!selectedRemoteId && hubDevices[0]) selectedRemoteId = hubDevices[0].id;
        renderRemoteDeviceButtons();
      } catch (e) {}
      return;
    }

    /* Hub: отримуємо drive-команди від Remote */
    if (mode === 'hub' && topic.indexOf(TOPIC_CONTROL) === 0) {
      const id = topic.slice(TOPIC_CONTROL.length);
      lastRemoteById[id] = Date.now();
      renderHubModalList();

      if (!window.isConnected) return;   /* BT не підключений — нічого не шлемо */
      try {
        const data = JSON.parse(text);
        if (data && data.type === 'drive') {
          applyTargetFromRemote(
            Number(data.l  || 0),
            Number(data.r  || 0),
            Number(data.m3 || 0),
            Number(data.m4 || 0)
          );
        } else if (data && data.type === 'scratch') {
          if (typeof window.processScratchCommandLocal === 'function')
            window.processScratchCommandLocal(data.cmd);
        }
      } catch (e) {}
    }
  }

  /* ══════════════════════════════════════════════
     PUBLISH (Remote side)
  ══════════════════════════════════════════════ */

  function publishDrive(l, r, m3, m4) {
    if (mode !== 'remote' || !mqttClient || !mqttConnected || !selectedRemoteId) return;
    const isStop = (l === 0 && r === 0 && (m3 || 0) === 0 && (m4 || 0) === 0);
    const now    = Date.now();

    /* Зупинку шлемо ЗАВЖДИ без throttle + дублюємо через 60мс */
    if (!isStop && now - lastDrivePublish < REMOTE_THROTTLE) return;
    lastDrivePublish = now;

    const payload = JSON.stringify({ type: 'drive', l, r, m3: m3||0, m4: m4||0, ts: now });
    mqttClient.publish(TOPIC_CONTROL + selectedRemoteId, payload, { qos: 0, retain: false });

    if (isStop) {
      setTimeout(function () {
        if (mqttClient && mqttConnected && selectedRemoteId) {
          mqttClient.publish(TOPIC_CONTROL + selectedRemoteId,
            JSON.stringify({ type: 'drive', l: 0, r: 0, m3: 0, m4: 0, ts: Date.now() }),
            { qos: 0, retain: false });
        }
      }, 60);
    }
  }

  function publishScratch(cmd) {
    if (!mqttClient || !mqttConnected || mode !== 'remote' || !selectedRemoteId) return;
    mqttClient.publish(TOPIC_CONTROL + selectedRemoteId,
      JSON.stringify({ type: 'scratch', cmd, ts: Date.now() }),
      { qos: 0, retain: false });
  }

  /* ══════════════════════════════════════════════
     UI helpers
  ══════════════════════════════════════════════ */

  function updateHubUi() {
    if (elBtDeviceList) elBtDeviceList.classList.add('hidden');
    if (elIotHubList && hubDevices.length) elIotHubList.classList.remove('hidden');
    const st = document.getElementById('btScanText');
    if (st) st.textContent = 'Підключені машинки:';
  }

  function showRemoteView() {
    renderRemoteDeviceButtons();
    if (elIotDeviceList) elIotDeviceList.classList.remove('hidden');
    if (elIotBackBtn)    elIotBackBtn.classList.remove('hidden');
    const st = document.getElementById('btScanText');
    if (st) st.textContent = 'Натисни «Сканувати» щоб оновити список';
    const sb = document.getElementById('btScanBtn');
    if (sb) {
      sb.onclick = function () { renderRemoteDeviceButtons(); };
      sb.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i> Сканувати';
    }
  }

  function showBtScanView() {
    if (elIotDeviceList) elIotDeviceList.classList.add('hidden');
    if (elIotBackBtn)    elIotBackBtn.classList.add('hidden');
    if (elBtDeviceList)  elBtDeviceList.classList.add('hidden');
    if (elBtActionRow)   elBtActionRow.style.display = '';
    if (elIotBigBtn)     elIotBigBtn.classList.add('hidden');
    const sb = document.getElementById('btScanBtn');
    if (sb) {
      sb.classList.remove('hidden');
      sb.onclick = function () { if (typeof window.startBtScan === 'function') window.startBtScan(); };
      sb.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i> Сканувати';
    }
    const st = document.getElementById('btScanText');
    if (st) st.textContent = 'Натисни «Сканувати» щоб знайти роботів';
    if (HAS_BLUETOOTH) mode = 'hub';
  }

  function disconnectDevice(id) {
    const item = hubDevices.find(x => x.id === id);
    if (item && item.ref && item.ref.gatt && item.ref.gatt.connected) {
      try { item.ref.gatt.disconnect(); } catch (e) {}
    }
  }

  /* ══════════════════════════════════════════════
     ГЛОБАЛЬНІ ХУКИ
  ══════════════════════════════════════════════ */

  /*
   * onDriveUpdate — викликається з sendDrivePacket (джойстик + Scratch).
   * Якщо активний Remote режим → шлемо через MQTT.
   */
  window.onDriveUpdate = function (data) {
    if (!data) return;
    publishDrive(data.l || 0, data.r || 0, data.m3 || 0, data.m4 || 0);
  };

  /*
   * sendDrivePacketBLE — окремий хук, який Hub-інтерполятор
   * використовує щоб слати до BLE БЕЗ зайвого round-trip.
   * Головний sendDrivePacket в index.html викликаємо тільки
   * з Remote-боку або при локальному управлінні.
   */
  window.sendDrivePacketBLE = null; // заповнюється з index.html нижче

  window.processScratchCommand = publishScratch;
  window.processScratchCommandLocal = function (cmd) { /* заглушка Hub */ };

  /* ══════════════════════════════════════════════
     IoT ACTIVE CHECK
     Використовується в index.html щоб дозволити
     Scratch-блокам виконуватись навіть без BT
  ══════════════════════════════════════════════ */
  window.isIoTRemoteActive = function () {
    return mode === 'remote' && mqttConnected;
  };

  /* ══════════════════════════════════════════════
     INIT
  ══════════════════════════════════════════════ */

  if (IS_IOS || !HAS_BLUETOOTH) {
    enableRemoteMode();
  } else {
    if (window._settings && window._settings.iotHub === true) enableHubMode();
  }

  ensureMqtt();
  updateRoomCodeUI();

  /* ══════════════════════════════════════════════
     EXPORT
  ══════════════════════════════════════════════ */
  const IOT = {};

  IOT.enableHubMode     = enableHubMode;
  IOT.disableHubMode    = disableHubMode;
  IOT.enableRemoteMode  = enableRemoteMode;
  IOT.disconnectDevice  = disconnectDevice;
  IOT.onBleConnected    = onBleConnected;
  IOT.onBleDisconnected = onBleDisconnected;
  IOT.getPrefix         = function () { return UNIQUE_PREFIX; };
  IOT.getRoomCode       = function () { return extractRoomCode(UNIQUE_PREFIX); };
  IOT.applyRoomCode     = applyRoomCode;

  IOT.openHubManager = function () {
    enableHubMode();
    if (elHubModal) {
      document.body.appendChild(elHubModal);
      elHubModal.classList.remove('hidden');
      elHubModal.style.display  = 'flex';
      elHubModal.style.zIndex   = '99999';
    }
    renderHubModalList();
    updateRoomCodeUI();
  };

  IOT.openRemoteManager = function () {
    if (typeof window.openBtModal === 'function') window.openBtModal();
    enableRemoteMode();
    showRemoteView();
  };

  IOT.showBtScan = function () { showBtScanView(); };

  window.IoTBridge = IOT;
})();
