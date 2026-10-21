/**
 * PowerFlow HUD — Interactive N-Bus Power Flow Visualizer
 * ========================================================
 * Main application logic: Canvas rendering, particle dynamics,
 * solver interface, matrix visualization, P-V curves, tooltips.
 */

const API = 'http://localhost:8000/api';

// ===== Global State =====
const state = {
  buses: {},
  lines: [],
  ybus: null,
  jacobian: null,
  converged: false,
  iteration: 0,
  mismatchHistory: [],
  summary: {},
  selectedBus: null,
  dragBus: null,
  dragOffset: { x: 0, y: 0 },
  particles: [],
  pvCurveData: null,
  collapseWarning: false,
  loadFactor: 1.0,
  canvasOffset: { x: 0, y: 0 },
  canvasScale: 1.0,
  autoSolve: false,
  animFrame: null,
  lastTime: 0,
};

// ===== Canvas Setup =====
const canvas = document.getElementById('powerCanvas');
const ctx = canvas.getContext('2d');
let canvasW, canvasH;

function resizeCanvas() {
  const rect = canvas.parentElement.getBoundingClientRect();
  canvasW = rect.width;
  canvasH = rect.height;
  canvas.width = canvasW * devicePixelRatio;
  canvas.height = canvasH * devicePixelRatio;
  canvas.style.width = canvasW + 'px';
  canvas.style.height = canvasH + 'px';
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();


// ===== API Helpers =====
async function apiGet(endpoint) {
  const res = await fetch(`${API}${endpoint}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

async function apiPost(endpoint, body = null) {
  const opts = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
  if (body !== null) opts.body = JSON.stringify(body);
  const res = await fetch(`${API}${endpoint}`, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `API error: ${res.status}`);
  }
  return res.json();
}

async function apiPut(endpoint, body) {
  const res = await fetch(`${API}${endpoint}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

async function apiDelete(endpoint) {
  const res = await fetch(`${API}${endpoint}`, { method: 'DELETE' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `API error: ${res.status}`);
  }
  return res.json();
}


// ===== State Management =====
function updateState(data) {
  if (data.buses) {
    state.buses = {};
    for (const [id, bus] of Object.entries(data.buses)) {
      state.buses[parseInt(id)] = bus;
    }
  }
  if (data.lines) state.lines = data.lines;
  if (data.ybus) state.ybus = data.ybus;
  if (data.jacobian !== undefined) state.jacobian = data.jacobian;
  if (data.converged !== undefined) state.converged = data.converged;
  if (data.iteration !== undefined) state.iteration = data.iteration;
  if (data.mismatch_history) state.mismatchHistory = data.mismatch_history;
  if (data.summary) state.summary = data.summary;

  if (data.step_result) {
    if (data.step_result.jacobian) state.jacobian = data.step_result.jacobian;
    if (data.step_result.mismatch_history) state.mismatchHistory = data.step_result.mismatch_history;
  }
  if (data.solve_result) {
    if (data.solve_result.mismatch_history) state.mismatchHistory = data.solve_result.mismatch_history;
  }

  updateUI();
  generateParticles();
}

function updateUI() {
  updateStatusIndicator();
  updateBusList();
  updateLineList();
  updateBusSelectors();
  updateYBusDisplay();
  updateJacobianDisplay();
  updateConvergenceChart();
  updateAnalytics();
  updateIterationDisplay();
}


// ===== Status Indicator =====
function updateStatusIndicator() {
  const dot = document.getElementById('statusDot');
  const text = document.getElementById('statusText');
  dot.className = 'status-dot';

  if (state.converged) {
    dot.classList.add('converged');
    text.textContent = `Converged (k=${state.iteration})`;
  } else if (state.iteration > 0) {
    dot.classList.add('running');
    text.textContent = `Iterating (k=${state.iteration})`;
  } else {
    dot.classList.add('idle');
    text.textContent = 'Idle';
  }
}

function updateIterationDisplay() {
  document.getElementById('iterCount').textContent = state.iteration;
  const mv = document.getElementById('mismatchValue');
  if (state.mismatchHistory.length > 0) {
    const last = state.mismatchHistory[state.mismatchHistory.length - 1];
    mv.textContent = last.toExponential(3);
    mv.className = 'mismatch-value ' + (last < 1e-6 ? 'good' : last < 0.01 ? 'moderate' : 'bad');
  } else {
    mv.textContent = '—';
    mv.className = 'mismatch-value';
  }
}


// ===== Bus List =====
function updateBusList() {
  const container = document.getElementById('busList');
  document.getElementById('busCount').textContent = Object.keys(state.buses).length;

  const busIds = Object.keys(state.buses).map(Number).sort((a, b) => a - b);
  container.innerHTML = busIds.map(id => {
    const bus = state.buses[id];
    const typeClass = bus.bus_type === 0 ? 'slack' : bus.bus_type === 1 ? 'pv' : 'pq';
    const typeLabel = bus.bus_type === 0 ? 'SLK' : bus.bus_type === 1 ? 'PV' : 'PQ';
    const selected = state.selectedBus === id ? ' selected' : '';
    return `
      <div class="bus-list-item${selected}" data-bus-id="${id}" onclick="selectBus(${id})">
        <div class="bus-icon ${typeClass}">${typeLabel}</div>
        <div class="bus-info">
          <div class="bus-name">Bus ${id}</div>
          <div class="bus-details">|V|=${bus.v_mag.toFixed(3)} ∠${bus.v_angle_deg.toFixed(1)}° P=${bus.p_net.toFixed(2)} Q=${bus.q_net.toFixed(2)}</div>
        </div>
      </div>
    `;
  }).join('');
}


// ===== Line List =====
function updateLineList() {
  const container = document.getElementById('lineList');
  document.getElementById('lineCount').textContent = state.lines.length;

  container.innerHTML = state.lines.map(line => {
    const inactive = !line.is_active ? ' inactive' : '';
    return `
      <div class="line-list-item${inactive}" data-line-id="${line.line_id}">
        <div>
          <div class="line-list-info">L${line.line_id}: Bus ${line.from_bus} → ${line.to_bus}</div>
          <div class="line-list-impedance">Z=${line.r}+j${line.x} B=${line.b}</div>
        </div>
        <div style="display:flex;gap:4px;">
          <button class="btn btn-ghost btn-sm" onclick="toggleLine(${line.line_id})" title="${line.is_active ? 'Trip' : 'Close'} Line">${line.is_active ? '⚡' : '✕'}</button>
          <button class="btn btn-danger btn-sm" onclick="deleteLine(${line.line_id})" title="Delete Line">🗑</button>
        </div>
      </div>
    `;
  }).join('');
}


// ===== Bus Selectors =====
function updateBusSelectors() {
  const busIds = Object.keys(state.buses).map(Number).sort((a, b) => a - b);
  const options = busIds.map(id => `<option value="${id}">Bus ${id}</option>`).join('');

  document.getElementById('lineFromBus').innerHTML = options;
  document.getElementById('lineToBus').innerHTML = options;
  document.getElementById('pvBusSelect').innerHTML = busIds
    .filter(id => state.buses[id].bus_type === 2)
    .map(id => `<option value="${id}">Bus ${id} (PQ)</option>`)
    .join('');
}


// ===== Select Bus =====
function selectBus(id) {
  state.selectedBus = id;
  updateBusList();
  showBusEditor(id);
}

function showBusEditor(id) {
  const bus = state.buses[id];
  if (!bus) return;

  document.getElementById('busEditorCard').style.display = 'block';
  document.getElementById('busEditorId').textContent = `Bus ${id}`;
  document.getElementById('editBusType').value = bus.bus_type;
  document.getElementById('editBusV').value = bus.v_mag;
  document.getElementById('editBusPGen').value = bus.p_gen;
  document.getElementById('editBusQGen').value = bus.q_gen;
  document.getElementById('editBusPLoad').value = bus.p_load;
  document.getElementById('editBusQLoad').value = bus.q_load;

  // Switch to analytics tab to show editor
  switchSidebarTab('analytics');
}


// ===== Y-Bus Matrix Display =====
function updateYBusDisplay() {
  if (!state.ybus || state.ybus.size === 0) return;
  const { labels, real, imag, size } = state.ybus;

  let html = '<table class="matrix-table"><thead><tr><th>Y-Bus</th>';
  for (const l of labels) html += `<th>Bus ${l}</th>`;
  html += '</tr></thead><tbody>';

  for (let i = 0; i < size; i++) {
    html += `<tr><th>Bus ${labels[i]}</th>`;
    for (let j = 0; j < size; j++) {
      const r = real[i][j];
      const im = imag[i][j];
      const isDiag = i === j;
      const isZero = Math.abs(r) < 1e-10 && Math.abs(im) < 1e-10;
      const cls = isDiag ? 'diagonal' : isZero ? 'zero' : 'off-diagonal';
      const sign = im >= 0 ? '+' : '';
      const txt = isZero ? '0' : `${r.toFixed(2)}${sign}j${im.toFixed(2)}`;
      html += `<td class="${cls}">${txt}</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  document.getElementById('ybusMatrixContainer').innerHTML = html;
}


// ===== Jacobian Display =====
function updateJacobianDisplay() {
  if (!state.jacobian) return;

  renderSubMatrix('j11Container', state.jacobian.J1, state.jacobian.pv_pq_buses, state.jacobian.pv_pq_buses, '∂P/∂θ');
  renderSubMatrix('j12Container', state.jacobian.J2, state.jacobian.pv_pq_buses, state.jacobian.pq_buses, '∂P/∂|V|');
  renderSubMatrix('j21Container', state.jacobian.J3, state.jacobian.pq_buses, state.jacobian.pv_pq_buses, '∂Q/∂θ');
  renderSubMatrix('j22Container', state.jacobian.J4, state.jacobian.pq_buses, state.jacobian.pq_buses, '∂Q/∂|V|');
}

function renderSubMatrix(containerId, matrix, rowLabels, colLabels, title) {
  const container = document.getElementById(containerId);
  if (!matrix || matrix.length === 0) {
    container.innerHTML = '<span style="color:var(--text-muted);font-size:10px;">Empty</span>';
    return;
  }

  let html = '<table class="matrix-table" style="font-size:10px;"><thead><tr><th></th>';
  for (const l of colLabels) html += `<th>${l}</th>`;
  html += '</tr></thead><tbody>';

  for (let i = 0; i < matrix.length; i++) {
    html += `<tr><th>${rowLabels[i]}</th>`;
    for (let j = 0; j < matrix[i].length; j++) {
      const v = matrix[i][j];
      const cls = i === j ? 'diagonal' : Math.abs(v) < 1e-10 ? 'zero' : 'off-diagonal';
      html += `<td class="${cls}">${v.toFixed(3)}</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  container.innerHTML = html;
}


// ===== Convergence Chart =====
function updateConvergenceChart() {
  const canvas = document.getElementById('convergenceChart');
  const c = canvas.getContext('2d');
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width * devicePixelRatio;
  canvas.height = rect.height * devicePixelRatio;
  canvas.style.width = rect.width + 'px';
  canvas.style.height = rect.height + 'px';
  c.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);

  const w = rect.width;
  const h = rect.height;
  const pad = { top: 30, right: 20, bottom: 40, left: 60 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;

  // Clear
  c.fillStyle = '#0a0e1a';
  c.fillRect(0, 0, w, h);

  // Title
  c.font = '10px "Orbitron", sans-serif';
  c.fillStyle = '#00ffff';
  c.textAlign = 'center';
  c.fillText('CONVERGENCE LOG — ||ΔP, ΔQ|| vs Iteration', w / 2, 18);

  const data = state.mismatchHistory;
  if (data.length < 1) {
    c.font = '11px "JetBrains Mono", monospace';
    c.fillStyle = '#64748b';
    c.fillText('Run solver to see convergence', w / 2, h / 2);
    return;
  }

  // Log scale
  const maxVal = Math.max(...data, 1e-1);
  const minVal = Math.min(...data.filter(v => v > 0), 1e-8);
  const logMax = Math.ceil(Math.log10(maxVal));
  const logMin = Math.floor(Math.log10(Math.max(minVal, 1e-10)));

  function xPos(i) { return pad.left + (i / Math.max(data.length - 1, 1)) * plotW; }
  function yPos(v) {
    const lv = Math.log10(Math.max(v, 1e-12));
    return pad.top + plotH - ((lv - logMin) / (logMax - logMin)) * plotH;
  }

  // Grid
  c.strokeStyle = 'rgba(0,255,255,0.08)';
  c.lineWidth = 0.5;
  for (let exp = logMin; exp <= logMax; exp++) {
    const y = yPos(Math.pow(10, exp));
    c.beginPath(); c.moveTo(pad.left, y); c.lineTo(w - pad.right, y); c.stroke();
    c.font = '9px "JetBrains Mono", monospace';
    c.fillStyle = '#64748b';
    c.textAlign = 'right';
    c.fillText(`1e${exp}`, pad.left - 5, y + 3);
  }

  // Tolerance line
  const tolY = yPos(1e-6);
  c.strokeStyle = 'rgba(34, 197, 94, 0.5)';
  c.lineWidth = 1;
  c.setLineDash([4, 4]);
  c.beginPath(); c.moveTo(pad.left, tolY); c.lineTo(w - pad.right, tolY); c.stroke();
  c.setLineDash([]);
  c.font = '8px "JetBrains Mono", monospace';
  c.fillStyle = '#22c55e';
  c.textAlign = 'left';
  c.fillText('ε = 1e-6', w - pad.right + 3, tolY + 3);

  // Data line
  c.strokeStyle = '#00ffff';
  c.lineWidth = 2;
  c.shadowColor = 'rgba(0,255,255,0.4)';
  c.shadowBlur = 8;
  c.beginPath();
  for (let i = 0; i < data.length; i++) {
    const x = xPos(i);
    const y = yPos(data[i]);
    if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
  }
  c.stroke();
  c.shadowBlur = 0;

  // Data points
  for (let i = 0; i < data.length; i++) {
    const x = xPos(i);
    const y = yPos(data[i]);
    c.fillStyle = data[i] < 1e-6 ? '#22c55e' : '#00ffff';
    c.beginPath(); c.arc(x, y, 3, 0, Math.PI * 2); c.fill();
  }

  // X-axis labels
  c.font = '9px "JetBrains Mono", monospace';
  c.fillStyle = '#64748b';
  c.textAlign = 'center';
  for (let i = 0; i < data.length; i++) {
    c.fillText(`k=${i}`, xPos(i), h - pad.bottom + 16);
  }

  // Axis labels
  c.font = '9px "Orbitron", sans-serif';
  c.fillStyle = '#94a3b8';
  c.textAlign = 'center';
  c.fillText('Iteration (k)', w / 2, h - 5);

  c.save();
  c.translate(12, h / 2);
  c.rotate(-Math.PI / 2);
  c.fillText('Max |Mismatch|', 0, 0);
  c.restore();
}


// ===== P-V Curve Chart =====
function drawPVCurve(data) {
  state.pvCurveData = data;
  const canvas = document.getElementById('pvCurveChart');
  const c = canvas.getContext('2d');
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width * devicePixelRatio;
  canvas.height = rect.height * devicePixelRatio;
  canvas.style.width = rect.width + 'px';
  canvas.style.height = rect.height + 'px';
  c.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);

  const w = rect.width;
  const h = rect.height;
  const pad = { top: 30, right: 30, bottom: 40, left: 55 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;

  c.fillStyle = '#0a0e1a';
  c.fillRect(0, 0, w, h);

  c.font = '10px "Orbitron", sans-serif';
  c.fillStyle = '#ff00ff';
  c.textAlign = 'center';
  c.fillText(`P-V NOSE CURVE — Bus ${data.bus_id}`, w / 2, 18);

  if (!data.p_values || data.p_values.length < 2) {
    c.font = '11px "JetBrains Mono", monospace';
    c.fillStyle = '#64748b';
    c.fillText('No data available', w / 2, h / 2);
    return;
  }

  const pMax = Math.max(...data.p_values) * 1.1 || 1;
  const vMin = Math.min(...data.v_values) * 0.9;
  const vMax = Math.max(...data.v_values) * 1.05;

  function xPos(p) { return pad.left + (p / pMax) * plotW; }
  function yPos(v) { return pad.top + plotH - ((v - vMin) / (vMax - vMin)) * plotH; }

  // Grid
  c.strokeStyle = 'rgba(255,0,255,0.06)';
  c.lineWidth = 0.5;
  for (let i = 0; i <= 5; i++) {
    const y = pad.top + (plotH / 5) * i;
    c.beginPath(); c.moveTo(pad.left, y); c.lineTo(w - pad.right, y); c.stroke();
    const v = vMax - ((vMax - vMin) / 5) * i;
    c.font = '9px "JetBrains Mono", monospace';
    c.fillStyle = '#64748b';
    c.textAlign = 'right';
    c.fillText(v.toFixed(3), pad.left - 5, y + 3);
  }

  // Curve
  c.strokeStyle = '#ff00ff';
  c.lineWidth = 2.5;
  c.shadowColor = 'rgba(255,0,255,0.4)';
  c.shadowBlur = 10;
  c.beginPath();
  for (let i = 0; i < data.p_values.length; i++) {
    const x = xPos(data.p_values[i]);
    const y = yPos(data.v_values[i]);
    if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
  }
  c.stroke();
  c.shadowBlur = 0;

  // Nose point
  if (data.nose_point) {
    const nx = xPos(data.nose_point.p);
    const ny = yPos(data.nose_point.v);

    // Danger zone
    c.fillStyle = 'rgba(239, 68, 68, 0.1)';
    c.fillRect(nx, pad.top, w - pad.right - nx, plotH);

    c.fillStyle = '#ef4444';
    c.beginPath(); c.arc(nx, ny, 6, 0, Math.PI * 2); c.fill();
    c.strokeStyle = 'rgba(239, 68, 68, 0.5)';
    c.lineWidth = 1;
    c.beginPath(); c.arc(nx, ny, 12, 0, Math.PI * 2); c.stroke();

    c.font = '8px "Orbitron", sans-serif';
    c.fillStyle = '#ef4444';
    c.textAlign = 'left';
    c.fillText('NOSE POINT', nx + 16, ny - 4);
    c.font = '8px "JetBrains Mono", monospace';
    c.fillText(`P=${data.nose_point.p.toFixed(3)} V=${data.nose_point.v.toFixed(3)}`, nx + 16, ny + 8);
  }

  // Current operating point (first point at 100% loading if available)
  const loadIdx = Math.round(data.p_values.length / 3);  // ~100% mark
  if (loadIdx < data.p_values.length) {
    const opX = xPos(data.p_values[loadIdx]);
    const opY = yPos(data.v_values[loadIdx]);
    c.fillStyle = '#22c55e';
    c.beginPath(); c.arc(opX, opY, 5, 0, Math.PI * 2); c.fill();
    c.font = '8px "JetBrains Mono", monospace';
    c.fillStyle = '#22c55e';
    c.textAlign = 'left';
    c.fillText('Operating Point', opX + 10, opY);
  }

  // Axis labels
  c.font = '9px "Orbitron", sans-serif';
  c.fillStyle = '#94a3b8';
  c.textAlign = 'center';
  c.fillText('Total Active Power Load (P) [p.u.]', w / 2, h - 5);

  c.save();
  c.translate(12, h / 2);
  c.rotate(-Math.PI / 2);
  c.fillText('Voltage |V| [p.u.]', 0, 0);
  c.restore();
}


// ===== Analytics =====
function updateAnalytics() {
  const s = state.summary;
  if (!s || !s.total_p_gen) return;

  const grid = document.getElementById('analyticsGrid');
  const minVClass = s.min_voltage < 0.95 ? 'danger' : s.min_voltage < 1.0 ? 'warning' : '';
  const loadClass = s.max_loading_pct > 80 ? 'danger' : s.max_loading_pct > 60 ? 'warning' : '';

  grid.innerHTML = `
    <div class="analytics-card">
      <div class="analytics-value">${s.total_p_gen?.toFixed(3) || '—'}</div>
      <div class="analytics-label">P Gen (p.u.)</div>
    </div>
    <div class="analytics-card">
      <div class="analytics-value">${s.total_q_gen?.toFixed(3) || '—'}</div>
      <div class="analytics-label">Q Gen (p.u.)</div>
    </div>
    <div class="analytics-card">
      <div class="analytics-value">${s.total_p_load?.toFixed(3) || '—'}</div>
      <div class="analytics-label">P Load (p.u.)</div>
    </div>
    <div class="analytics-card">
      <div class="analytics-value">${s.total_q_load?.toFixed(3) || '—'}</div>
      <div class="analytics-label">Q Load (p.u.)</div>
    </div>
    <div class="analytics-card warning">
      <div class="analytics-value">${s.total_p_loss?.toFixed(4) || '—'}</div>
      <div class="analytics-label">P Loss (p.u.)</div>
    </div>
    <div class="analytics-card warning">
      <div class="analytics-value">${s.total_q_loss?.toFixed(4) || '—'}</div>
      <div class="analytics-label">Q Loss (p.u.)</div>
    </div>
    <div class="analytics-card ${minVClass}">
      <div class="analytics-value">${s.min_voltage?.toFixed(4) || '—'}</div>
      <div class="analytics-label">Min |V| (Bus ${s.min_voltage_bus || '—'})</div>
    </div>
    <div class="analytics-card ${loadClass}">
      <div class="analytics-value">${s.max_loading_pct?.toFixed(1) || '—'}%</div>
      <div class="analytics-label">Max Loading (L${s.max_loading_line || '—'})</div>
    </div>
    <div class="analytics-card ${s.converged ? 'success' : 'danger'}">
      <div class="analytics-value">${s.converged ? '✓' : '✗'}</div>
      <div class="analytics-label">Convergence</div>
    </div>
    <div class="analytics-card">
      <div class="analytics-value">${s.iterations || 0}</div>
      <div class="analytics-label">Iterations</div>
    </div>
  `;
}


// ===== Particle System =====
function generateParticles() {
  state.particles = [];

  for (const line of state.lines) {
    if (!line.is_active) continue;
    if (line.p_from === undefined) continue;

    const fromBus = state.buses[line.from_bus];
    const toBus = state.buses[line.to_bus];
    if (!fromBus || !toBus) continue;

    const pFlow = Math.abs(line.p_from);
    const qFlow = line.q_from || 0;
    const direction = line.p_from >= 0 ? 1 : -1;
    const loading = line.loading_pct || 0;

    // Number of particles proportional to power flow
    const numParticles = Math.max(3, Math.min(20, Math.round(pFlow * 25)));
    const speed = Math.max(0.3, Math.min(3, pFlow * 2));

    for (let i = 0; i < numParticles; i++) {
      state.particles.push({
        lineId: line.line_id,
        fromX: fromBus.x, fromY: fromBus.y,
        toX: toBus.x, toY: toBus.y,
        t: Math.random(),  // Position along line [0, 1]
        speed: speed * (0.8 + Math.random() * 0.4),
        direction: direction,
        qFlow: qFlow,
        loading: loading,
        size: 1.5 + pFlow * 1.5,
      });
    }
  }
}


// ===== Main Canvas Rendering =====
function render(timestamp) {
  const dt = Math.min((timestamp - state.lastTime) / 1000, 0.05);
  state.lastTime = timestamp;

  ctx.clearRect(0, 0, canvasW, canvasH);

  // Background grid
  drawGrid();

  ctx.save();
  ctx.translate(state.canvasOffset.x, state.canvasOffset.y);
  ctx.scale(state.canvasScale, state.canvasScale);

  // Draw lines
  drawLines();

  // Update and draw particles
  updateParticles(dt);
  drawParticles();

  // Draw buses
  drawBuses();

  ctx.restore();

  state.animFrame = requestAnimationFrame(render);
}

function drawGrid() {
  const gridSize = 40;
  ctx.strokeStyle = 'rgba(0, 255, 255, 0.03)';
  ctx.lineWidth = 0.5;

  for (let x = 0; x < canvasW; x += gridSize) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvasH); ctx.stroke();
  }
  for (let y = 0; y < canvasH; y += gridSize) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvasW, y); ctx.stroke();
  }
}

function drawLines() {
  for (const line of state.lines) {
    const fromBus = state.buses[line.from_bus];
    const toBus = state.buses[line.to_bus];
    if (!fromBus || !toBus) continue;

    const loading = line.loading_pct || 0;
    let color, width;

    if (!line.is_active) {
      color = 'rgba(100, 116, 139, 0.3)';
      width = 1;
      ctx.setLineDash([4, 4]);
    } else if (loading > 80) {
      color = `rgba(239, 68, 68, ${0.6 + 0.4 * Math.sin(Date.now() / 200)})`;
      width = 2 + loading / 40;
    } else if (loading > 50) {
      color = 'rgba(251, 191, 36, 0.7)';
      width = 2 + loading / 60;
    } else {
      color = 'rgba(34, 197, 94, 0.5)';
      width = 2;
    }

    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(fromBus.x, fromBus.y);
    ctx.lineTo(toBus.x, toBus.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Line label
    const mx = (fromBus.x + toBus.x) / 2;
    const my = (fromBus.y + toBus.y) / 2;
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.fillStyle = 'rgba(148, 163, 184, 0.6)';
    ctx.textAlign = 'center';
    ctx.fillText(`L${line.line_id}`, mx, my - 8);

    if (line.p_from !== undefined && line.is_active) {
      ctx.font = '8px "JetBrains Mono", monospace';
      ctx.fillStyle = 'rgba(0, 255, 255, 0.5)';
      ctx.fillText(`P=${Math.abs(line.p_from).toFixed(2)}`, mx, my + 6);
      ctx.fillStyle = line.q_from >= 0 ? 'rgba(0, 255, 255, 0.4)' : 'rgba(255, 0, 255, 0.4)';
      ctx.fillText(`Q=${line.q_from?.toFixed(2) || '0'}`, mx, my + 16);
    }
  }
}

function updateParticles(dt) {
  for (const p of state.particles) {
    p.t += p.speed * p.direction * dt * 0.3;
    if (p.t > 1) p.t -= 1;
    if (p.t < 0) p.t += 1;
  }
}

function drawParticles() {
  for (const p of state.particles) {
    const x = p.fromX + (p.toX - p.fromX) * p.t;
    const y = p.fromY + (p.toY - p.fromY) * p.t;

    // Color based on reactive power flow
    let color;
    if (p.qFlow >= 0) {
      color = `rgba(0, 255, 255, ${0.5 + 0.3 * Math.sin(Date.now() / 300 + p.t * 10)})`;
    } else {
      color = `rgba(255, 0, 255, ${0.5 + 0.3 * Math.sin(Date.now() / 300 + p.t * 10)})`;
    }

    // Glow
    ctx.shadowColor = p.qFlow >= 0 ? 'rgba(0, 255, 255, 0.6)' : 'rgba(255, 0, 255, 0.6)';
    ctx.shadowBlur = 6;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, p.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }
}

function drawBuses() {
  const busIds = Object.keys(state.buses).map(Number).sort((a, b) => a - b);

  for (const id of busIds) {
    const bus = state.buses[id];
    const x = bus.x;
    const y = bus.y;
    const isSelected = state.selectedBus === id;

    // Bus type styling
    let mainColor, label, glowColor;
    if (bus.bus_type === 0) {
      mainColor = '#22c55e'; label = 'SLK'; glowColor = 'rgba(34, 197, 94, 0.4)';
    } else if (bus.bus_type === 1) {
      mainColor = '#fbbf24'; label = 'PV'; glowColor = 'rgba(251, 191, 36, 0.4)';
    } else {
      mainColor = '#0ea5e9'; label = 'PQ'; glowColor = 'rgba(14, 165, 233, 0.4)';
    }

    // Selection ring
    if (isSelected) {
      ctx.strokeStyle = '#00ffff';
      ctx.lineWidth = 2;
      ctx.shadowColor = 'rgba(0, 255, 255, 0.5)';
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(x, y, 32, 0, Math.PI * 2);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // Main bus circle
    ctx.shadowColor = glowColor;
    ctx.shadowBlur = 15;
    ctx.fillStyle = mainColor;
    ctx.beginPath();
    ctx.arc(x, y, 20, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Inner circle
    ctx.fillStyle = '#0a0e1a';
    ctx.beginPath();
    ctx.arc(x, y, 16, 0, Math.PI * 2);
    ctx.fill();

    // Bus label
    ctx.font = 'bold 10px "Orbitron", sans-serif';
    ctx.fillStyle = mainColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x, y - 2);

    ctx.font = '8px "JetBrains Mono", monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillText(id, x, y + 8);

    // ===== Voltage Magnitude Gauge (Pressure Gauge) =====
    drawVoltageGauge(x, y, bus.v_mag, mainColor);

    // ===== Phase Angle Phasor Wheel =====
    drawPhasorWheel(x, y, bus.v_angle, bus.v_mag, mainColor);

    // Voltage/power info below bus
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(226, 232, 240, 0.8)';
    ctx.fillText(`|V|=${bus.v_mag.toFixed(3)}`, x, y + 46);
    ctx.fillStyle = 'rgba(148, 163, 184, 0.6)';
    ctx.fillText(`∠${bus.v_angle_deg.toFixed(1)}°`, x, y + 57);
  }
}


function drawVoltageGauge(cx, cy, vMag, color) {
  // Pressure gauge to the LEFT of the bus
  const gx = cx - 42;
  const gy = cy;
  const gw = 10;
  const gh = 36;

  // Gauge outline
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.3)';
  ctx.lineWidth = 1;
  ctx.strokeRect(gx - gw / 2, gy - gh / 2, gw, gh);

  // Fill level (voltage clamped 0.8 to 1.2)
  const level = Math.max(0, Math.min(1, (vMag - 0.8) / 0.4));
  const fillH = gh * level;

  // Color based on voltage health
  let fillColor;
  if (vMag >= 0.95 && vMag <= 1.05) fillColor = '#22c55e';
  else if (vMag >= 0.9 && vMag <= 1.1) fillColor = '#fbbf24';
  else fillColor = '#ef4444';

  ctx.fillStyle = fillColor;
  ctx.globalAlpha = 0.6;
  ctx.fillRect(gx - gw / 2, gy + gh / 2 - fillH, gw, fillH);
  ctx.globalAlpha = 1;

  // Label
  ctx.font = '7px "JetBrains Mono", monospace';
  ctx.fillStyle = 'rgba(148, 163, 184, 0.5)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText('|V|', gx, gy - gh / 2 - 2);
}


function drawPhasorWheel(cx, cy, angle, vMag, color) {
  // Phasor wheel to the RIGHT of the bus
  const px = cx + 42;
  const py = cy;
  const r = 14;

  // Reference circle
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.2)';
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.arc(px, py, r, 0, Math.PI * 2);
  ctx.stroke();

  // Reference line (0°)
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.15)';
  ctx.beginPath();
  ctx.moveTo(px, py);
  ctx.lineTo(px + r, py);
  ctx.stroke();

  // Phasor arrow (negative angle because canvas Y is inverted)
  const phasorLen = r * Math.min(vMag, 1.2);
  const endX = px + phasorLen * Math.cos(-angle);
  const endY = py + phasorLen * Math.sin(-angle);

  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.shadowColor = color;
  ctx.shadowBlur = 4;
  ctx.beginPath();
  ctx.moveTo(px, py);
  ctx.lineTo(endX, endY);
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Arrowhead
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(endX, endY, 2, 0, Math.PI * 2);
  ctx.fill();

  // Angle label
  ctx.font = '7px "JetBrains Mono", monospace';
  ctx.fillStyle = 'rgba(148, 163, 184, 0.5)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText('∠θ', px, py - r - 2);
}


// ===== Canvas Interaction =====
let isPanning = false;
let panStart = { x: 0, y: 0 };

canvas.addEventListener('mousedown', (e) => {
  const rect = canvas.getBoundingClientRect();
  const mx = (e.clientX - rect.left - state.canvasOffset.x) / state.canvasScale;
  const my = (e.clientY - rect.top - state.canvasOffset.y) / state.canvasScale;

  // Check if clicking on a bus
  const clickedBus = findBusAt(mx, my);

  if (clickedBus !== null) {
    state.dragBus = clickedBus;
    const bus = state.buses[clickedBus];
    state.dragOffset = { x: mx - bus.x, y: my - bus.y };
    selectBus(clickedBus);
  } else {
    // Start panning
    isPanning = true;
    panStart = { x: e.clientX - state.canvasOffset.x, y: e.clientY - state.canvasOffset.y };
  }
});

canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const mx = (e.clientX - rect.left - state.canvasOffset.x) / state.canvasScale;
  const my = (e.clientY - rect.top - state.canvasOffset.y) / state.canvasScale;

  if (state.dragBus !== null) {
    const bus = state.buses[state.dragBus];
    bus.x = mx - state.dragOffset.x;
    bus.y = my - state.dragOffset.y;
    generateParticles();
  } else if (isPanning) {
    state.canvasOffset.x = e.clientX - panStart.x;
    state.canvasOffset.y = e.clientY - panStart.y;
  } else {
    // Tooltip hover
    const hoveredBus = findBusAt(mx, my);
    handleTooltip(e, hoveredBus, mx, my);
  }
});

canvas.addEventListener('mouseup', async (e) => {
  if (state.dragBus !== null) {
    const bus = state.buses[state.dragBus];
    // Update bus position on server
    try {
      await apiPut(`/bus/${state.dragBus}`, { x: bus.x, y: bus.y });
    } catch (err) { /* ignore position update errors */ }
    state.dragBus = null;
  }
  isPanning = false;
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const scaleFactor = e.deltaY > 0 ? 0.95 : 1.05;
  state.canvasScale = Math.max(0.3, Math.min(3, state.canvasScale * scaleFactor));
});

function findBusAt(mx, my) {
  for (const [id, bus] of Object.entries(state.buses)) {
    const dx = mx - bus.x;
    const dy = my - bus.y;
    if (dx * dx + dy * dy < 25 * 25) {
      return parseInt(id);
    }
  }
  return null;
}


// ===== Tooltips =====
const tooltipEl = document.getElementById('tooltipOverlay');
const tooltipTitle = document.getElementById('tooltipTitle');
const tooltipBody = document.getElementById('tooltipBody');

const TOOLTIP_TEXTS = {
  bus: {
    0: {
      title: 'Slack Bus (Reference)',
      body: `<strong>The anchor of the system.</strong> Voltage magnitude and angle are fixed (usually 1.0∠0°).
      <div class="insight">💡 Think of it as an "infinite reservoir" — it supplies whatever P and Q the system needs to balance.</div>`
    },
    1: {
      title: 'PV Generator Bus',
      body: `<strong>Voltage-controlled generator.</strong> |V| and P are specified; Q is calculated by the solver.
      <div class="insight">💡 Like a water pump maintaining constant pressure — it adjusts reactive power output to hold voltage.</div>
      <div class="formula">Q is free to vary within limits [Q_min, Q_max]</div>`
    },
    2: {
      title: 'PQ Load Bus',
      body: `<strong>Constant power load.</strong> Both P and Q demand are specified; |V| and θ are unknown.
      <div class="insight">💡 Like a drain at a fixed flow rate — the system must adjust to supply it. Voltage "sags" when overloaded!</div>
      <div class="formula">P = P_load, Q = Q_load → Solve for |V|, θ</div>`
    },
  },
  physics: {
    active_power: `<strong>Active Power (P)</strong> flows from higher θ to lower θ.
    <div class="formula">P_ij ≈ (|V_i|·|V_j| / X) · sin(θ_i - θ_j)</div>
    <div class="insight">💡 P depends primarily on <strong>phase angle difference (Δθ)</strong> — like water flowing downhill due to pressure difference.</div>`,
    reactive_power: `<strong>Reactive Power (Q)</strong> flows from higher |V| to lower |V|.
    <div class="formula">Q_ij ≈ (|V_i|² - |V_i|·|V_j|·cos(Δθ)) / X</div>
    <div class="insight">💡 Q depends primarily on <strong>voltage magnitude difference (Δ|V|)</strong> — like osmotic pressure equalizing fluid levels.</div>`,
    jacobian: `<strong>The Jacobian Matrix [J]</strong> is the multi-dimensional slope/derivative of the power-voltage relationship.
    <div class="formula">[ΔP; ΔQ] = [J] · [Δθ; Δ|V|]</div>
    <div class="insight">💡 Just like a robot arm's Jacobian maps joint velocities to end-effector velocities in inverse kinematics, the power system Jacobian maps voltage changes to power changes.</div>`,
  }
};

function handleTooltip(e, hoveredBusId, mx, my) {
  if (hoveredBusId !== null) {
    const bus = state.buses[hoveredBusId];
    const info = TOOLTIP_TEXTS.bus[bus.bus_type];
    tooltipTitle.innerHTML = `Bus ${hoveredBusId} — ${info.title}`;

    let bodyHTML = info.body;
    bodyHTML += `<hr style="border-color:rgba(0,255,255,0.1);margin:8px 0;">`;
    bodyHTML += `<strong>|V|</strong> = ${bus.v_mag.toFixed(4)} p.u. &nbsp; <strong>θ</strong> = ${bus.v_angle_deg.toFixed(2)}°<br>`;
    bodyHTML += `<strong>P_net</strong> = ${bus.p_net.toFixed(3)} &nbsp; <strong>Q_net</strong> = ${bus.q_net.toFixed(3)}`;
    bodyHTML += `<hr style="border-color:rgba(0,255,255,0.1);margin:8px 0;">`;
    bodyHTML += TOOLTIP_TEXTS.physics.active_power;

    tooltipBody.innerHTML = bodyHTML;
    tooltipEl.style.left = (e.clientX + 16) + 'px';
    tooltipEl.style.top = (e.clientY - 10) + 'px';
    tooltipEl.classList.add('visible');
  } else {
    tooltipEl.classList.remove('visible');
  }
}

canvas.addEventListener('mouseleave', () => {
  tooltipEl.classList.remove('visible');
});


// ===== Tab Switching =====
function switchSidebarTab(tabName) {
  document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.sidebar-panel').forEach(p => p.classList.remove('active'));
  document.querySelector(`.sidebar-tab[data-tab="${tabName}"]`)?.classList.add('active');
  document.getElementById(`panel-${tabName}`)?.classList.add('active');
}

document.querySelectorAll('.sidebar-tab').forEach(tab => {
  tab.addEventListener('click', () => switchSidebarTab(tab.dataset.tab));
});

document.querySelectorAll('.bottom-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.bottom-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.bottom-panel-inner').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`bpanel-${tab.dataset.btab}`)?.classList.add('active');
    // Redraw charts when switching
    if (tab.dataset.btab === 'convergence') updateConvergenceChart();
    if (tab.dataset.btab === 'pvcurve' && state.pvCurveData) drawPVCurve(state.pvCurveData);
  });
});


// ===== Preset Buttons =====
document.querySelectorAll('.preset-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    try {
      const data = await apiPost(`/preset/${btn.dataset.preset}`);
      updateState(data);
    } catch (err) {
      console.error('Failed to load preset:', err);
    }
  });
});


// ===== Add Bus =====
document.getElementById('addBusBtn').addEventListener('click', async () => {
  const busType = parseInt(document.getElementById('newBusType').value);
  const existingIds = Object.keys(state.buses).map(Number);
  const newId = existingIds.length > 0 ? Math.max(...existingIds) + 1 : 1;

  const body = {
    bus_id: newId,
    bus_type: busType,
    v_mag: busType === 0 ? 1.05 : busType === 1 ? 1.04 : 1.0,
    p_gen: busType === 1 ? 0.5 : 0,
    p_load: busType === 2 ? 0.5 : 0,
    q_load: busType === 2 ? 0.2 : 0,
    x: 200 + Math.random() * 400,
    y: 150 + Math.random() * 300,
  };

  try {
    const data = await apiPost('/bus', body);
    updateState(data);
    if (state.autoSolve) autoSolve();
  } catch (err) {
    alert(err.message);
  }
});


// ===== Add Line =====
document.getElementById('addLineBtn').addEventListener('click', async () => {
  const fromBus = parseInt(document.getElementById('lineFromBus').value);
  const toBus = parseInt(document.getElementById('lineToBus').value);

  if (fromBus === toBus) {
    alert('Cannot connect a bus to itself');
    return;
  }

  const existingIds = state.lines.map(l => l.line_id);
  const newId = existingIds.length > 0 ? Math.max(...existingIds) + 1 : 1;

  const body = {
    line_id: newId,
    from_bus: fromBus,
    to_bus: toBus,
    r: parseFloat(document.getElementById('lineR').value) || 0.02,
    x: parseFloat(document.getElementById('lineX').value) || 0.06,
    b: parseFloat(document.getElementById('lineB').value) || 0.03,
    rating: parseFloat(document.getElementById('lineRating').value) || 2.0,
  };

  try {
    const data = await apiPost('/line', body);
    updateState(data);
    if (state.autoSolve) autoSolve();
  } catch (err) {
    alert(err.message);
  }
});


// ===== Toggle/Delete Line =====
async function toggleLine(lineId) {
  try {
    const data = await apiPost(`/line/${lineId}/toggle`);
    updateState(data);
    if (state.autoSolve) autoSolve();
  } catch (err) {
    alert(err.message);
  }
}

async function deleteLine(lineId) {
  try {
    const data = await apiDelete(`/line/${lineId}`);
    updateState(data);
    if (state.autoSolve) autoSolve();
  } catch (err) {
    alert(err.message);
  }
}


// ===== Bus Editor =====
document.getElementById('updateBusBtn').addEventListener('click', async () => {
  if (state.selectedBus === null) return;

  const body = {
    bus_type: parseInt(document.getElementById('editBusType').value),
    v_mag: parseFloat(document.getElementById('editBusV').value),
    p_gen: parseFloat(document.getElementById('editBusPGen').value),
    q_gen: parseFloat(document.getElementById('editBusQGen').value),
    p_load: parseFloat(document.getElementById('editBusPLoad').value),
    q_load: parseFloat(document.getElementById('editBusQLoad').value),
  };

  try {
    const data = await apiPut(`/bus/${state.selectedBus}`, body);
    updateState(data);
    if (state.autoSolve) autoSolve();
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById('deleteBusBtn').addEventListener('click', async () => {
  if (state.selectedBus === null) return;
  if (!confirm(`Delete Bus ${state.selectedBus}?`)) return;

  try {
    const data = await apiDelete(`/bus/${state.selectedBus}`);
    state.selectedBus = null;
    document.getElementById('busEditorCard').style.display = 'none';
    updateState(data);
    if (state.autoSolve) autoSolve();
  } catch (err) {
    alert(err.message);
  }
});


// ===== Solver Controls =====
document.getElementById('stepSolveBtn').addEventListener('click', async () => {
  try {
    const data = await apiPost('/solver/step');
    updateState(data);
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById('autoSolveBtn').addEventListener('click', async () => {
  await autoSolve();
});

document.getElementById('resetSolverBtn').addEventListener('click', async () => {
  try {
    const data = await apiPost('/solver/reset');
    updateState(data);
  } catch (err) {
    alert(err.message);
  }
});

async function autoSolve() {
  try {
    const data = await apiPost('/solver/solve');
    updateState(data);
  } catch (err) {
    console.error('Auto-solve failed:', err);
  }
}

document.getElementById('autoSolveToggle').addEventListener('change', (e) => {
  state.autoSolve = e.target.checked;
});

document.getElementById('applySettingsBtn').addEventListener('click', async () => {
  const tol = parseFloat(document.getElementById('solverTolerance').value);
  const maxIter = parseInt(document.getElementById('solverMaxIter').value);
  try {
    await apiPost('/solver/settings', { tolerance: tol, max_iterations: maxIter });
  } catch (err) {
    alert(err.message);
  }
});


// ===== Load Scaling =====
const loadSlider = document.getElementById('loadScaleSlider');
const loadValue = document.getElementById('loadScaleValue');

loadSlider.addEventListener('input', () => {
  loadValue.textContent = loadSlider.value + '%';
});

document.getElementById('applyLoadScale').addEventListener('click', async () => {
  const factor = parseInt(loadSlider.value) / 100;
  try {
    const data = await apiPost('/analysis/scale-load', { factor });
    updateState(data);

    // Check for voltage collapse
    const minV = data.summary?.min_voltage;
    if (minV !== null && minV < 0.7) {
      state.collapseWarning = true;
      document.getElementById('collapseAlert').classList.add('visible');
      setTimeout(() => {
        document.getElementById('collapseAlert').classList.remove('visible');
        state.collapseWarning = false;
      }, 5000);
    }
  } catch (err) {
    alert(err.message);
  }
});


// ===== P-V Curve =====
document.getElementById('computePVBtn').addEventListener('click', async () => {
  const busId = parseInt(document.getElementById('pvBusSelect').value);
  if (isNaN(busId)) {
    alert('Select a PQ bus first');
    return;
  }
  try {
    const data = await apiPost('/analysis/pv-curve', { bus_id: busId, steps: 60, max_loading: 3.0 });
    drawPVCurve(data);
    // Switch to P-V curve tab
    document.querySelectorAll('.bottom-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.bottom-panel-inner').forEach(p => p.classList.remove('active'));
    document.getElementById('btab-pvcurve').classList.add('active');
    document.getElementById('bpanel-pvcurve').classList.add('active');
  } catch (err) {
    alert(err.message);
  }
});


// ===== Canvas Controls =====
document.getElementById('zoomInBtn').addEventListener('click', () => {
  state.canvasScale = Math.min(3, state.canvasScale * 1.2);
});
document.getElementById('zoomOutBtn').addEventListener('click', () => {
  state.canvasScale = Math.max(0.3, state.canvasScale / 1.2);
});
document.getElementById('resetViewBtn').addEventListener('click', () => {
  state.canvasScale = 1;
  state.canvasOffset = { x: 0, y: 0 };
});


// ===== Bottom Panel Resize =====
const bottomPanel = document.querySelector('.bottom-panel');
const resizeHandle = document.getElementById('bottomResizeHandle');
let isResizing = false;
let startY, startHeight;

resizeHandle.addEventListener('mousedown', (e) => {
  isResizing = true;
  startY = e.clientY;
  startHeight = bottomPanel.offsetHeight;
  document.body.style.cursor = 'ns-resize';
  e.preventDefault();
});

document.addEventListener('mousemove', (e) => {
  if (!isResizing) return;
  const dy = startY - e.clientY;
  bottomPanel.style.height = Math.max(100, Math.min(600, startHeight + dy)) + 'px';
});

document.addEventListener('mouseup', () => {
  if (isResizing) {
    isResizing = false;
    document.body.style.cursor = '';
    resizeCanvas();
  }
});


// ===== Initial Load =====
async function init() {
  try {
    const data = await apiGet('/system');
    updateState(data);
    // Auto-solve the default preset
    await autoSolve();
  } catch (err) {
    console.error('Failed to connect to backend:', err);
    document.getElementById('statusText').textContent = 'Backend offline — start the Python server';
    document.getElementById('statusDot').className = 'status-dot diverged';
  }

  // Start render loop
  state.animFrame = requestAnimationFrame(render);
}

init();
