/* ================================================================
   IoT Bridge для RoboScratch
   - Hub (ПК/Android): Bluetooth + MQTT
   - Remote (iPhone): MQTT only
   Коментарі українською, щоб було легше правити
   ================================================================ */
(function() {
  'use strict';

  const IOT = {};
  const HAS_BLUETOOTH = !!(navigator && navigator.bluetooth);
  const IS_IOS = /iPhone|iPad|iPod/i.test(navigator.userAgent || '');

  const PREFIX_KEY = 'roboscratch_iot_prefix';
  const UNIQUE_PREFIX = getOrCreatePrefix();
  const TOPIC_ROOT = UNIQUE_PREFIX + '/hub_1';
  const TOPIC_STATUS = TOPIC_ROOT + '/status';
  const TOPIC_CONTROL = TOPIC_ROOT + '/control/';

  const MQTT_URL = 'wss://broker.hivemq.com:8884/mqtt';

  let mqttClient = null;
  let mqttConnected = false;
  let mode = null; // 'hub' | 'remote'
  let hubDevices = []; // [{id,name,code,ref}]
  let selectedRemoteId = null;
  let statusTimer = null;
  let lastDrivePublish = 0;
  const lastRemoteById = {};

  const elBtActionRow = document.getElementById('btActionRow');
  const elIotBigBtn = document.getElementById('iotBigBtn');
  const elBtScanText = document.getElementById('btScanText');
  const elBtStatusDot = document.getElementById('btStatusDot');
  const elMqttStatusDot = document.getElementById('mqttStatusDot');
  const elIotDeviceList = document.getElementById('iotDeviceList');
  const elIotHubList = document.getElementById('iotHubList');
  const elBtDeviceList = document.getElementById('btDeviceList');
  const elIotBackBtn = document.getElementById('iotBackBtn');
  const elHubModal = document.getElementById('iotHubModal');
  const elHubModalList = document.getElementById('iotHubModalList');
  const elHubSummary = document.getElementById('iotHubSummary');
  const elHubSub = document.getElementById('iotHubModalSub');

  function getOrCreatePrefix() {
    try {
      const existing = localStorage.getItem(PREFIX_KEY);
      if (existing) return existing;
      const id = 'roboscratch_v1_' + Math.random().toString(36).slice(2, 8);
      localStorage.setItem(PREFIX_KEY, id);
      return id;
    } catch (e) {
      return 'roboscratch_v1_fallback';
    }
  }

  function setDot(el, ok) {
    if (!el) return;
    el.classList.remove('bg-red-500', 'bg-green-500');
    el.classList.add(ok ? 'bg-green-500' : 'bg-red-500');
  }

  function ensureMqtt() {
    if (mqttClient || !window.mqtt) return;
    const clientId = UNIQUE_PREFIX + '_' + Math.random().toString(16).slice(2, 6);
    mqttClient = window.mqtt.connect(MQTT_URL, { clientId, reconnectPeriod: 2000 });

    mqttClient.on('connect', function() {
      mqttConnected = true;
      setDot(elMqttStatusDot, true);
      if (mode === 'hub') subscribeHub();
      if (mode === 'remote') subscribeRemote();
    });
    mqttClient.on('close', function() {
      mqttConnected = false;
      setDot(elMqttStatusDot, false);
    });
    mqttClient.on('error', function() {
      mqttConnected = false;
      setDot(elMqttStatusDot, false);
    });
  }

  function subscribeHub() {
    if (!mqttClient) return;
    mqttClient.subscribe(TOPIC_CONTROL + '+');
  }

  function subscribeRemote() {
    if (!mqttClient) return;
    mqttClient.subscribe(TOPIC_STATUS);
  }

  function publishStatus() {
    if (!mqttClient || !mqttConnected) return;
    const payload = JSON.stringify({ devices: hubDevices, ts: Date.now() });
    mqttClient.publish(TOPIC_STATUS, payload, { qos: 0, retain: false });
  }

  function renderRemoteDeviceButtons() {
    if (!elIotDeviceList) return;
    elIotDeviceList.innerHTML = '';
    if (!hubDevices.length) {
      const empty = document.createElement('div');
      empty.className = 'w-full px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-slate-400 text-xs';
      empty.textContent = 'Немає доступних машинок';
      elIotDeviceList.appendChild(empty);
      elIotDeviceList.classList.remove('hidden');
      return;
    }
    elIotDeviceList.classList.remove('hidden');
    hubDevices.forEach(function(d) {
      const btn = document.createElement('button');
      btn.className = 'w-full py-2 rounded-xl border border-blue-500/30 bg-blue-500/10 text-blue-200 text-xs font-semibold';
      btn.textContent = d.name + ' (' + d.id + ')';
      if (selectedRemoteId === d.id) {
        btn.style.boxShadow = 'inset 0 -12px 18px rgba(59,130,246,0.35), inset 0 -2px 0 rgba(59,130,246,0.6)';
      }
      btn.onclick = function() {
        selectedRemoteId = d.id;
        renderRemoteDeviceButtons();
      };
      elIotDeviceList.appendChild(btn);
    });
  }

  function renderHubDeviceList() {
    if (!elIotHubList) return;
    elIotHubList.innerHTML = '';
    if (!hubDevices.length) {
      const empty = document.createElement('div');
      empty.className = 'w-full px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-slate-400 text-xs';
      empty.textContent = 'Немає підключених машинок';
      elIotHubList.appendChild(empty);
      elIotHubList.classList.remove('hidden');
      return;
    }
    elIotHubList.classList.remove('hidden');
    hubDevices.forEach(function(d) {
      const row = document.createElement('div');
      row.className = 'w-full px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-slate-200 text-xs flex items-center justify-between gap-3';
      const left = document.createElement('div');
      left.textContent = d.name + ' • ' + d.code;
      const right = document.createElement('button');
      right.className = 'px-2 py-1 rounded-lg border border-red-500/40 text-red-300 text-[10px]';
      right.textContent = 'Disconnect';
      right.onclick = function() { disconnectDevice(d.id); };
      row.appendChild(left);
      row.appendChild(right);
      elIotHubList.appendChild(row);
    });
  }

  function renderHubModalList() {
    if (!elHubModalList) return;
    elHubModalList.innerHTML = '';
    if (elHubSummary) elHubSummary.textContent = 'Підключено машинок: ' + hubDevices.length;
    if (elHubSub) elHubSub.textContent = hubDevices.length ? 'Список активних машинок хаба' : 'Поки немає підключених машинок';
    if (!hubDevices.length) {
      const empty = document.createElement('div');
      empty.className = 'w-full px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-slate-400 text-xs';
      empty.textContent = 'Немає підключених машинок';
      elHubModalList.appendChild(empty);
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
      row.appendChild(left);
      row.appendChild(right);
      elHubModalList.appendChild(row);
    });
  }

  function enableHubMode() {
    mode = 'hub';
    if (window._settings) { window._settings.iotHub = true; try { localStorage.setItem('rb_settings', JSON.stringify(window._settings)); } catch(e){} }
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
  }

  function onBleConnected(dev) {
    setDot(elBtStatusDot, true);
    if (!dev) return;
    const id = sanitizeId(dev.id || dev.name || 'robot');
    const name = dev.name || 'Робот';
    if (!hubDevices.find(x => x.id === id)) {
      const code = makeRobotCode(id);
      hubDevices.push({ id, name, code, ref: dev });
    } else {
      const item = hubDevices.find(x => x.id === id);
      if (item && !item.ref) item.ref = dev;
    }
    if (mode === 'hub') publishStatus();
    if (mode === 'hub') renderHubDeviceList();
    if (mode === 'hub') updateHubUi();
    if (mode === 'hub') renderHubModalList();
  }

  function onBleDisconnected(dev) {
    setDot(elBtStatusDot, false);
    if (!dev) return;
    const id = sanitizeId(dev.id || dev.name || 'robot');
    hubDevices = hubDevices.filter(x => x.id !== id);
    if (mode === 'hub') publishStatus();
    if (mode === 'hub') renderHubDeviceList();
    if (mode === 'hub') updateHubUi();
    if (mode === 'hub') renderHubModalList();
  }

  function sanitizeId(raw) {
    return String(raw || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'robot';
  }

  function makeRobotCode(id) {
    const suffix = id.slice(-4).toUpperCase();
    return 'RB-' + suffix;
  }

  function handleMqttMessage(topic, message) {
    const text = message ? message.toString() : '';
    if (mode === 'remote' && topic === TOPIC_STATUS) {
      try {
        const data = JSON.parse(text);
        hubDevices = Array.isArray(data.devices) ? data.devices : [];
        if (!selectedRemoteId && hubDevices[0]) selectedRemoteId = hubDevices[0].id;
        renderRemoteDeviceButtons();
      } catch (e) {}
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
          const l = Number(data.l || 0);
          const r = Number(data.r || 0);
          const m3 = Number(data.m3 || 0);
          const m4 = Number(data.m4 || 0);
          window.sendDrivePacket(l, r, m3, m4);
        } else if (data && data.type === 'scratch') {
          // Заглушка для команди Scratch
          if (typeof window.processScratchCommandLocal === 'function') {
            window.processScratchCommandLocal(data.cmd);
          }
        }
      } catch (e) {}
    }
  }

  function publishDrive(l, r) {
    if (mode !== 'remote' || !mqttClient || !mqttConnected) return;
    if (!selectedRemoteId) return;
    const now = Date.now();
    if (now - lastDrivePublish < 80) return; // легкий тротлінг
    lastDrivePublish = now;
    const payload = JSON.stringify({ type: 'drive', l: l, r: r, ts: now });
    mqttClient.publish(TOPIC_CONTROL + selectedRemoteId, payload, { qos: 0, retain: false });
  }

  function publishScratch(cmd) {
    if (!mqttClient || !mqttConnected) return;
    if (mode !== 'remote' || !selectedRemoteId) return;
    const payload = JSON.stringify({ type: 'scratch', cmd: cmd, ts: Date.now() });
    mqttClient.publish(TOPIC_CONTROL + selectedRemoteId, payload, { qos: 0, retain: false });
  }

  // === Глобальні хуки ===
  window.onDriveUpdate = function(data) {
    if (!data) return;
    publishDrive(data.l, data.r);
  };

  // Заглушка для Scratch-команд
  window.processScratchCommand = function(cmd) {
    publishScratch(cmd);
  };

  // Локальна обробка Scratch (Hub)
  window.processScratchCommandLocal = function(cmd) {
    // Тут можна реалізувати локальну обробку для Hub
  };

  // MQTT listener
  function bindMqttListener() {
    if (!mqttClient) return;
    mqttClient.on('message', handleMqttMessage);
  }

  // === Ініціалізація ===
  if (IS_IOS || !HAS_BLUETOOTH) {
    enableRemoteMode();
  } else {
    // ПК/Android: Hub тільки якщо увімкнено в налаштуваннях
    if (window._settings && window._settings.iotHub === true) enableHubMode();
  }

  ensureMqtt();
  bindMqttListener();

  // === Експорт ===
  IOT.enableHubMode = enableHubMode;
  IOT.disableHubMode = disableHubMode;
  IOT.disconnectDevice = disconnectDevice;
  IOT.openHubManager = function() {
    enableHubMode();
    if (elHubModal) {
      elHubModal.classList.remove('hidden');
      elHubModal.style.display = 'block';
    }
    renderHubModalList();
  };

  IOT.openRemoteManager = function() {
    if (typeof window.openBtModal === 'function') window.openBtModal();
    enableRemoteMode();
    showRemoteView();
  };

  IOT.showBtScan = function() {
    showBtScanView();
  };

  function showRemoteView() {
    renderRemoteDeviceButtons();
    if (elIotDeviceList) elIotDeviceList.classList.remove('hidden');
    if (elIotBackBtn) elIotBackBtn.classList.remove('hidden');
    const scanText = document.getElementById('btScanText');
    if (scanText) scanText.textContent = 'Натисни «Сканувати» щоб оновити список';
    const scanBtn = document.getElementById('btScanBtn');
    if (scanBtn) {
      scanBtn.onclick = function(){ renderRemoteDeviceButtons(); };
      scanBtn.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i> Сканувати';
    }
  }

  function showBtScanView() {
    if (elIotDeviceList) elIotDeviceList.classList.add('hidden');
    if (elIotBackBtn) elIotBackBtn.classList.add('hidden');
    if (elBtDeviceList) elBtDeviceList.classList.add('hidden');
    if (elBtActionRow) elBtActionRow.style.display = '';
    if (elIotBigBtn) elIotBigBtn.classList.add('hidden');
    const scanBtnEl = document.getElementById('btScanBtn');
    if (scanBtnEl) scanBtnEl.classList.remove('hidden');
    const scanText = document.getElementById('btScanText');
    if (scanText) scanText.textContent = 'Натисни «Сканувати» щоб знайти роботів';
    const scanBtn = document.getElementById('btScanBtn');
    if (scanBtn) {
      scanBtn.onclick = function(){ if (typeof window.startBtScan === 'function') window.startBtScan(); };
      scanBtn.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i> Сканувати';
    }
    if (HAS_BLUETOOTH) mode = 'hub';
  }


  function updateHubUi() {
    if (elBtDeviceList) elBtDeviceList.classList.add('hidden');
    if (elIotHubList && hubDevices.length) elIotHubList.classList.remove('hidden');
    const scanText = document.getElementById('btScanText');
    if (scanText) scanText.textContent = 'Підключені машинки:';
  }

  function disconnectDevice(id) {
    const item = hubDevices.find(x => x.id === id);
    if (item && item.ref && item.ref.gatt && item.ref.gatt.connected) {
      try { item.ref.gatt.disconnect(); } catch(e){}
    }
  }
  IOT.enableRemoteMode = enableRemoteMode;
  IOT.onBleConnected = onBleConnected;
  IOT.onBleDisconnected = onBleDisconnected;
  IOT.getPrefix = function() { return UNIQUE_PREFIX; };

  window.IoTBridge = IOT;
})();
