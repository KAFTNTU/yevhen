/* ================================================================
   IoT Bridge для RoboScratch
   - Hub (ПК/Android): Bluetooth + MQTT
   - Remote (iPhone): MQTT only
   - Room Code: обидва пристрої вводять однаковий код
   ================================================================ */
(function() {
  'use strict';

  const IOT = {};
  const HAS_BLUETOOTH = !!(navigator && navigator.bluetooth);
  const IS_IOS = /iPhone|iPad|iPod/i.test(navigator.userAgent || '');

  const PREFIX_KEY = 'roboscratch_iot_prefix';
  const MQTT_URL = 'wss://broker.hivemq.com:8884/mqtt';

  let UNIQUE_PREFIX = getOrCreatePrefix();
  let TOPIC_ROOT    = UNIQUE_PREFIX + '/hub_1';
  let TOPIC_STATUS  = TOPIC_ROOT + '/status';
  let TOPIC_CONTROL = TOPIC_ROOT + '/control/';

  let mqttClient = null;
  let mqttConnected = false;
  let mode = null;
  let hubDevices = [];
  let selectedRemoteId = null;
  let statusTimer = null;
  let lastDrivePublish = 0;

  // Command Hold — повторює останню команду в проміжках між MQTT пакетами
  let holdTimer = null;
  let lastHeldCmd = null;
  const HOLD_INTERVAL_MS = 40;   // повторюємо команду кожні 40мс
  const HOLD_STOP_MS    = 300;   // зупиняємо якщо пакетів не було 300мс

  function startCommandHold(l, r, m3, m4) {
    lastHeldCmd = { l, r, m3, m4, ts: Date.now() };
    if (holdTimer) return;
    holdTimer = setInterval(function() {
      if (!lastHeldCmd) return;
      if (Date.now() - lastHeldCmd.ts > HOLD_STOP_MS) {
        if (window.isConnected && typeof window.sendDrivePacket === 'function') {
          window.sendDrivePacket(0, 0, 0, 0);
        }
        clearInterval(holdTimer); holdTimer = null; lastHeldCmd = null;
        return;
      }
      if (window.isConnected && typeof window.sendDrivePacket === 'function') {
        window.sendDrivePacket(lastHeldCmd.l, lastHeldCmd.r, lastHeldCmd.m3, lastHeldCmd.m4);
      }
    }, HOLD_INTERVAL_MS);
  }
  const lastRemoteById = {};

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

  /* ---------- Room Code ---------- */

  function getOrCreatePrefix() {
    try {
      const existing = localStorage.getItem(PREFIX_KEY);
      if (existing) return existing;
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
    try { localStorage.setItem(PREFIX_KEY, newPrefix); } catch(e) {}
    UNIQUE_PREFIX = newPrefix;
    TOPIC_ROOT    = UNIQUE_PREFIX + '/hub_1';
    TOPIC_STATUS  = TOPIC_ROOT + '/status';
    TOPIC_CONTROL = TOPIC_ROOT + '/control/';
    if (mqttClient) {
      try { mqttClient.end(true); } catch(e) {}
      mqttClient = null;
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

  /* ---------- MQTT ---------- */

  function setDot(el, ok) {
    if (!el) return;
    el.classList.remove('bg-red-500','bg-green-500');
    el.classList.add(ok ? 'bg-green-500' : 'bg-red-500');
  }

  function ensureMqtt() {
    if (mqttClient || !window.mqtt) return;
    const clientId = UNIQUE_PREFIX + '_' + Math.random().toString(16).slice(2,6);
    mqttClient = window.mqtt.connect(MQTT_URL, { clientId, reconnectPeriod: 2000 });
    mqttClient.on('connect', function() {
      mqttConnected = true;
      setDot(elMqttStatusDot, true);
      if (mode === 'hub')    subscribeHub();
      if (mode === 'remote') subscribeRemote();
    });
    mqttClient.on('close', function() { mqttConnected = false; setDot(elMqttStatusDot, false); });
    mqttClient.on('error', function() { mqttConnected = false; setDot(elMqttStatusDot, false); });
    mqttClient.on('message', handleMqttMessage);
  }

  function subscribeHub()    { if (mqttClient) mqttClient.subscribe(TOPIC_CONTROL + '+'); }
  function subscribeRemote() { if (mqttClient) mqttClient.subscribe(TOPIC_STATUS); }

  function publishStatus() {
    if (!mqttClient || !mqttConnected) return;
    mqttClient.publish(TOPIC_STATUS, JSON.stringify({ devices: hubDevices, ts: Date.now() }), { qos: 0, retain: true });
  }

  /* ---------- Render ---------- */

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
    hubDevices.forEach(function(d) {
      const btn = document.createElement('button');
      btn.className = 'w-full py-2 rounded-xl border border-blue-500/30 bg-blue-500/10 text-blue-200 text-xs font-semibold';
      btn.textContent = d.name + ' (' + d.id + ')';
      if (selectedRemoteId === d.id) btn.style.boxShadow = 'inset 0 -12px 18px rgba(59,130,246,0.35)';
      btn.onclick = function() { selectedRemoteId = d.id; renderRemoteDeviceButtons(); };
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
    hubDevices.forEach(function(d) {
      const row = document.createElement('div');
      row.className = 'w-full px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-slate-200 text-xs flex items-center justify-between gap-3';
      const left = document.createElement('div'); left.textContent = d.name + ' • ' + d.code;
      const right = document.createElement('button');
      right.className = 'px-2 py-1 rounded-lg border border-red-500/40 text-red-300 text-[10px]';
      right.textContent = 'Disconnect';
      right.onclick = function() { disconnectDevice(d.id); };
      row.appendChild(left); row.appendChild(right);
      elIotHubList.appendChild(row);
    });
  }

  function renderHubModalList() {
    if (!elHubModalList) return;
    elHubModalList.innerHTML = '';
    if (elHubSummary) elHubSummary.textContent = 'Підключено машинок: ' + hubDevices.length;
    if (elHubSub) elHubSub.textContent = hubDevices.length ? 'Список активних машинок хаба' : 'Поки немає підключених машинок';
    if (!hubDevices.length) {
      const e = document.createElement('div');
      e.className = 'w-full px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-slate-400 text-xs';
      e.textContent = 'Немає підключених машинок';
      elHubModalList.appendChild(e);
      return;
    }
    const now = Date.now();
    hubDevices.forEach(function(d) {
      const row = document.createElement('div');
      row.className = 'w-full px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-slate-200 text-xs flex items-center justify-between gap-3';
      const left = document.createElement('div');
      const active = (now - (lastRemoteById[d.id] || 0)) < 6000;
      const dot = document.createElement('span');
      dot.style.cssText = 'display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;background:' + (active ? '#22c55e' : '#ef4444');
      left.appendChild(dot);
      left.appendChild(document.createTextNode(d.name + ' • ' + d.code));
      const right = document.createElement('button');
      right.className = 'px-2 py-1 rounded-lg border border-red-500/40 text-red-300 text-[10px]';
      right.textContent = 'Disconnect';
      right.onclick = function() { disconnectDevice(d.id); };
      row.appendChild(left); row.appendChild(right);
      elHubModalList.appendChild(row);
    });
  }

  /* ---------- Modes ---------- */

  function enableHubMode() {
    mode = 'hub';
    if (window._settings) {
      window._settings.iotHub = true;
      try { localStorage.setItem('rb_settings', JSON.stringify(window._settings)); } catch(e) {}
    }
    ensureMqtt();
    if (mqttConnected) subscribeHub();
    if (elBtActionRow) elBtActionRow.style.display = '';
    if (elIotBigBtn) elIotBigBtn.classList.add('hidden');
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
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
    if (mqttClient && mqttConnected) {
      try { mqttClient.unsubscribe(TOPIC_CONTROL + '+'); } catch(e) {}
    }
  }

  function enableRemoteMode() {
    mode = 'remote';
    ensureMqtt();
    if (mqttConnected) subscribeRemote();
    if (elBtActionRow) elBtActionRow.style.display = 'none';
    if (elIotBigBtn) elIotBigBtn.classList.remove('hidden');
    if (elBtScanText) elBtScanText.textContent = 'Режим IoT (Remote)';
    setDot(elBtStatusDot, false);
    if (elIotHubList) elIotHubList.classList.add('hidden');
    updateRoomCodeUI();
  }

  /* ---------- BLE ---------- */

  function onBleConnected(dev) {
    setDot(elBtStatusDot, true);
    if (!dev) return;
    const id = sanitizeId(dev.id || dev.name || 'robot');
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
    if (!dev) return;
    const id = sanitizeId(dev.id || dev.name || 'robot');
    hubDevices = hubDevices.filter(x => x.id !== id);
    if (mode === 'hub') { publishStatus(); renderHubDeviceList(); updateHubUi(); renderHubModalList(); }
  }

  function sanitizeId(raw) {
    return String(raw || '').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,32) || 'robot';
  }
  function makeRobotCode(id) { return 'RB-' + id.slice(-4).toUpperCase(); }

  /* ---------- MQTT messages ---------- */

  function handleMqttMessage(topic, message) {
    const text = message ? message.toString() : '';
    if (mode === 'remote' && topic === TOPIC_STATUS) {
      try {
        const data = JSON.parse(text);
        hubDevices = Array.isArray(data.devices) ? data.devices : [];
        if (!selectedRemoteId && hubDevices[0]) selectedRemoteId = hubDevices[0].id;
        renderRemoteDeviceButtons();
      } catch(e) {}
      return;
    }
    if (mode === 'hub' && topic.indexOf(TOPIC_CONTROL) === 0) {
      const id = topic.slice(TOPIC_CONTROL.length);
      lastRemoteById[id] = Date.now();
      renderHubModalList();
      if (!window.isConnected || typeof window.sendDrivePacket !== 'function') return;
      try {
        const data = JSON.parse(text);
        if (data && data.type === 'drive') {
          const dl=Number(data.l||0),dr=Number(data.r||0),dm3=Number(data.m3||0),dm4=Number(data.m4||0);
          window.sendDrivePacket(dl,dr,dm3,dm4);
          // Джойстик 0 — моментально зупиняємо hold, не повторюємо
          if (dl === 0 && dr === 0 && dm3 === 0 && dm4 === 0) {
            if (holdTimer) { clearInterval(holdTimer); holdTimer = null; }
            lastHeldCmd = null;
          } else {
            startCommandHold(dl,dr,dm3,dm4);
          }
        } else if (data && data.type === 'scratch') {
          if (typeof window.processScratchCommandLocal === 'function') window.processScratchCommandLocal(data.cmd);
        }
      } catch(e) {}
    }
  }

  /* ---------- Publish ---------- */

  function publishDrive(l, r) {
    if (mode !== 'remote' || !mqttClient || !mqttConnected || !selectedRemoteId) return;
    const isStop = (l === 0 && r === 0);
    const now = Date.now();
    // Зупинку шлемо ЗАВЖДИ без throttle — моментальний стоп
    if (!isStop && now - lastDrivePublish < 40) return;
    lastDrivePublish = now;
    mqttClient.publish(TOPIC_CONTROL + selectedRemoteId, JSON.stringify({type:'drive',l,r,ts:now}), {qos:0,retain:false});
    // Для зупинки шлемо двічі щоб точно дійшло
    if (isStop) {
      setTimeout(function() {
        if (mqttClient && mqttConnected) {
          mqttClient.publish(TOPIC_CONTROL + selectedRemoteId, JSON.stringify({type:'drive',l:0,r:0,ts:Date.now()}), {qos:0,retain:false});
        }
      }, 50);
    }
  }

  function publishScratch(cmd) {
    if (!mqttClient || !mqttConnected || mode !== 'remote' || !selectedRemoteId) return;
    mqttClient.publish(TOPIC_CONTROL + selectedRemoteId, JSON.stringify({type:'scratch',cmd,ts:Date.now()}), {qos:0,retain:false});
  }

  /* ---------- UI helpers ---------- */

  function updateHubUi() {
    if (elBtDeviceList) elBtDeviceList.classList.add('hidden');
    if (elIotHubList && hubDevices.length) elIotHubList.classList.remove('hidden');
    const st = document.getElementById('btScanText');
    if (st) st.textContent = 'Підключені машинки:';
  }

  function showRemoteView() {
    renderRemoteDeviceButtons();
    if (elIotDeviceList) elIotDeviceList.classList.remove('hidden');
    if (elIotBackBtn) elIotBackBtn.classList.remove('hidden');
    const st = document.getElementById('btScanText');
    if (st) st.textContent = 'Натисни «Сканувати» щоб оновити список';
    const sb = document.getElementById('btScanBtn');
    if (sb) { sb.onclick = function(){ renderRemoteDeviceButtons(); }; sb.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i> Сканувати'; }
  }

  function showBtScanView() {
    if (elIotDeviceList) elIotDeviceList.classList.add('hidden');
    if (elIotBackBtn) elIotBackBtn.classList.add('hidden');
    if (elBtDeviceList) elBtDeviceList.classList.add('hidden');
    if (elBtActionRow) elBtActionRow.style.display = '';
    if (elIotBigBtn) elIotBigBtn.classList.add('hidden');
    const sb = document.getElementById('btScanBtn');
    if (sb) { sb.classList.remove('hidden'); sb.onclick = function(){ if(typeof window.startBtScan==='function') window.startBtScan(); }; sb.innerHTML='<i class="fa-solid fa-magnifying-glass"></i> Сканувати'; }
    const st = document.getElementById('btScanText');
    if (st) st.textContent = 'Натисни «Сканувати» щоб знайти роботів';
    if (HAS_BLUETOOTH) mode = 'hub';
  }

  function disconnectDevice(id) {
    const item = hubDevices.find(x => x.id === id);
    if (item && item.ref && item.ref.gatt && item.ref.gatt.connected) {
      try { item.ref.gatt.disconnect(); } catch(e) {}
    }
  }

  /* ---------- Init ---------- */

  window.onDriveUpdate = function(data) { if (data) publishDrive(data.l, data.r); };
  window.processScratchCommand = publishScratch;
  window.processScratchCommandLocal = function(cmd) {};

  if (IS_IOS || !HAS_BLUETOOTH) {
    enableRemoteMode();
  } else {
    if (window._settings && window._settings.iotHub === true) enableHubMode();
  }

  ensureMqtt();
  updateRoomCodeUI();

  /* ---------- Export ---------- */

  IOT.enableHubMode     = enableHubMode;
  IOT.disableHubMode    = disableHubMode;
  IOT.enableRemoteMode  = enableRemoteMode;
  IOT.disconnectDevice  = disconnectDevice;
  IOT.onBleConnected    = onBleConnected;
  IOT.onBleDisconnected = onBleDisconnected;
  IOT.getPrefix         = function() { return UNIQUE_PREFIX; };
  IOT.getRoomCode       = function() { return extractRoomCode(UNIQUE_PREFIX); };
  IOT.applyRoomCode     = applyRoomCode;

  IOT.openHubManager = function() {
    enableHubMode();
    if (elHubModal) {
      document.body.appendChild(elHubModal);
      elHubModal.classList.remove('hidden');
      elHubModal.style.display = 'flex';
      elHubModal.style.zIndex = '99999';
    }
    renderHubModalList();
    updateRoomCodeUI();
  };

  IOT.openRemoteManager = function() {
    if (typeof window.openBtModal === 'function') window.openBtModal();
    enableRemoteMode();
    showRemoteView();
  };

  IOT.showBtScan = function() { showBtScanView(); };

  window.IoTBridge = IOT;
})();
