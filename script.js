/* =========================================================
   MESA DE REGISTRO — script.js
   Lee una hoja de Google Sheets pública (gviz JSON, sin API key)
   con columnas: CODIGO | FECHA | HORA | REGISTRO
   CODIGO = "Colegio-Participante-Fecha"
   ========================================================= */

(() => {
  "use strict";

  const STORAGE_KEY = "regDashboardConfig";

  /* ---------------- state ---------------- */
  const state = {
    config: { sheetId: "", sheetRef: "", autoSeconds: 60 },
    raw: [],        // normalized rows
    filtered: [],   // after filters
    autoTimer: null,
    charts: {}      // Chart.js instances
  };

  /* ---------------- DOM refs ---------------- */
  const $ = (sel) => document.querySelector(sel);
  const dom = {
    connDot: $("#connDot"),
    connText: $("#connText"),
    connStatus: $("#connStatus"),
    lastUpdated: $("#lastUpdated"),
    refreshBtn: $("#refreshBtn"),
    autoToggle: $("#autoRefreshToggle"),
    settingsBtn: $("#settingsBtn"),

    dataBanner: $("#dataBanner"),
    dataBannerText: $("#dataBannerText"),
    dashMain: $("#dashMain"),

    fDateFrom: $("#fDateFrom"),
    fDateTo: $("#fDateTo"),
    fTimeFrom: $("#fTimeFrom"),
    fTimeTo: $("#fTimeTo"),
    fColegio: $("#fColegio"),
    fSearch: $("#fSearch"),
    applyFilters: $("#applyFilters"),
    clearFilters: $("#clearFilters"),
    exportCsv: $("#exportCsv"),

    kpiLeaderSchool: $("#kpiLeaderSchool"),
    kpiLeaderCount: $("#kpiLeaderCount"),
    kpiTotalRegs: $("#kpiTotalRegs"),
    kpiUniqueParticipants: $("#kpiUniqueParticipants"),
    kpiTotalSchools: $("#kpiTotalSchools"),

    tableBody: $("#dataTableBody"),
    tableCount: $("#tableCount"),

    settingsOverlay: $("#settingsOverlay"),
    settingsClose: $("#settingsClose"),
    settingsCancel: $("#settingsCancel"),
    settingsSave: $("#settingsSave"),
    settingsError: $("#settingsError"),
    cfgSheetId: $("#cfgSheetId"),
    cfgSheetName: $("#cfgSheetName"),
    cfgAutoSeconds: $("#cfgAutoSeconds"),
  };

  /* =========================================================
     CONFIG (localStorage)
     ========================================================= */
  function loadConfig() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      Object.assign(state.config, saved);
    } catch (e) { /* ignore malformed config */ }
  }

  function saveConfig() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.config));
  }

  /* =========================================================
     GOOGLE SHEETS (gviz) FETCH
     ========================================================= */
  function buildGvizUrl(sheetId, sheetRef) {
    const base = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/gviz/tq?tqx=out:json`;
    if (!sheetRef) return base;
    if (/^gid:/i.test(sheetRef.trim())) {
      return `${base}&gid=${encodeURIComponent(sheetRef.trim().slice(4))}`;
    }
    return `${base}&sheet=${encodeURIComponent(sheetRef.trim())}`;
  }

  async function fetchSheet() {
    const { sheetId, sheetRef } = state.config;
    if (!sheetId) {
      openSettings();
      return;
    }
    setConnStatus("loading");

    try {
      const url = buildGvizUrl(sheetId, sheetRef);
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();

      const match = text.match(/google\.visualization\.Query\.setResponse\(([\s\S]*)\);?\s*$/);
      if (!match) throw new Error("Respuesta inesperada de Google Sheets. Verifica que la hoja sea pública.");
      const json = JSON.parse(match[1]);

      if (json.status === "error") {
        const msg = (json.errors && json.errors[0] && json.errors[0].detailed_message) || "Error al leer la hoja.";
        throw new Error(msg);
      }

      const rows = parseGvizTable(json.table);
      if (!rows.length) {
        showBanner("La hoja se conectó correctamente, pero no se encontraron filas con datos.");
        state.raw = [];
      } else {
        hideBanner();
        state.raw = rows;
      }

      setConnStatus("ok");
      dom.lastUpdated.textContent = `Última lectura: ${formatClock(new Date())}`;
      populateSchoolFilter();
      applyFilters();
    } catch (err) {
      console.error(err);
      setConnStatus("error");
      showBanner(`No se pudo leer la hoja: <strong>${escapeHtml(err.message || String(err))}</strong>. Revisa el ID, el nombre de pestaña y que el acceso sea público ("Cualquier persona con el enlace → Lector").`);
    }
  }

  function parseGvizTable(table) {
    const labels = (table.cols || []).map(c => (c.label || "").trim().toUpperCase());
    const idx = {
      codigo: labels.indexOf("CODIGO") !== -1 ? labels.indexOf("CODIGO") : (labels.indexOf("CÓDIGO") !== -1 ? labels.indexOf("CÓDIGO") : 0),
      fecha: labels.indexOf("FECHA") !== -1 ? labels.indexOf("FECHA") : 1,
      hora: labels.indexOf("HORA") !== -1 ? labels.indexOf("HORA") : 2,
      registro: (labels.indexOf("REGISTO") !== -1 ? labels.indexOf("REGISTO") : labels.indexOf("REGISTRO")) !== -1
        ? (labels.indexOf("REGISTO") !== -1 ? labels.indexOf("REGISTO") : labels.indexOf("REGISTRO"))
        : 3,
    };

    const out = [];
    const seenCodigos = new Set();
    (table.rows || []).forEach((row) => {
      const cells = row.c || [];
      const codigoRaw = cellText(cells[idx.codigo]).trim();

      // omitir vacíos
      if (!codigoRaw) return;
      // omitir códigos puramente numéricos (sin colegio/participante real)
      if (/^\d+([.,]\d+)?$/.test(codigoRaw)) return;
      // omitir duplicados (mismo código ya registrado)
      const codigoKey = codigoRaw.toLowerCase();
      if (seenCodigos.has(codigoKey)) return;
      seenCodigos.add(codigoKey);

      const fechaRaw = cellText(cells[idx.fecha]);
      const horaRaw = cellText(cells[idx.hora]);
      const registroRaw = cellText(cells[idx.registro]);

      const { colegio, participante } = parseCodigo(codigoRaw);
      const fechaDate = parseFlexibleDate(fechaRaw) || parseFlexibleDate(codigoRaw.split("-").pop());
      const horaMinutes = parseTimeToMinutes(horaRaw);

      out.push({
        codigo: codigoRaw,
        colegio: colegio || "Sin colegio",
        participante: participante || "—",
        fechaStr: fechaRaw || (fechaDate ? formatDate(fechaDate) : "—"),
        fechaDate,
        horaStr: horaRaw || "—",
        horaMinutes,
        registro: registroRaw || "—",
      });
    });
    return out;
  }

  function cellText(cell) {
    if (!cell) return "";
    if (typeof cell.f === "string" && cell.f.trim() !== "") return cell.f.trim();
    if (cell.v === null || cell.v === undefined) return "";
    if (typeof cell.v === "string" && cell.v.startsWith("Date(")) {
      const d = parseGvizDate(cell.v);
      return d ? formatDate(d) : "";
    }
    return String(cell.v).trim();
  }

  function parseGvizDate(v) {
    // Format: Date(2024,0,15) or Date(2024,0,15,14,30,0)
    const m = /Date\((\d+),(\d+),(\d+)(?:,(\d+),(\d+),(\d+))?\)/.exec(v);
    if (!m) return null;
    const [, y, mo, d, h = 0, mi = 0, s = 0] = m.map(Number);
    return new Date(y, mo, d, h, mi, s);
  }

  /* =========================================================
     PARSING HELPERS
     ========================================================= */
  function parseCodigo(codigo) {
    const parts = codigo.split("-").map(p => p.trim()).filter(Boolean);
    if (parts.length < 2) return { colegio: parts[0] || codigo, participante: "" };
    const colegio = parts[0];
    const participante = parts.slice(1, parts.length > 2 ? -1 : parts.length).join("-") || parts[1];
    return { colegio, participante };
  }

  function parseFlexibleDate(str) {
    if (!str) return null;
    str = String(str).trim();
    if (!str) return null;

    // dd/mm/yyyy or dd-mm-yyyy
    let m = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/.exec(str);
    if (m) {
      let [, d, mo, y] = m;
      y = y.length === 2 ? `20${y}` : y;
      const dt = new Date(Number(y), Number(mo) - 1, Number(d));
      if (!isNaN(dt)) return dt;
    }
    // yyyy-mm-dd
    m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(str);
    if (m) {
      const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      if (!isNaN(dt)) return dt;
    }
    const fallback = new Date(str);
    return isNaN(fallback) ? null : fallback;
  }

  function parseTimeToMinutes(str) {
    if (!str) return null;
    str = String(str).trim();
    let m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|am|pm)?$/.exec(str);
    if (!m) return null;
    let [, h, mi, , ampm] = m;
    h = Number(h); mi = Number(mi);
    if (ampm) {
      ampm = ampm.toUpperCase();
      if (ampm === "PM" && h < 12) h += 12;
      if (ampm === "AM" && h === 12) h = 0;
    }
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
  }

  function formatDate(d) {
    if (!d) return "—";
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    return `${dd}/${mm}/${d.getFullYear()}`;
  }

  function formatClock(d) {
    return d.toLocaleTimeString("es-BO", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /* =========================================================
     FILTERS
     ========================================================= */
  function populateSchoolFilter() {
    const schools = Array.from(new Set(state.raw.map(r => r.colegio))).sort((a, b) => a.localeCompare(b));
    const current = dom.fColegio.value;
    dom.fColegio.innerHTML = `<option value="">Todos los colegios</option>` +
      schools.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");
    if (schools.includes(current)) dom.fColegio.value = current;
  }

  function applyFilters() {
    const dateFrom = dom.fDateFrom.value ? new Date(dom.fDateFrom.value + "T00:00:00") : null;
    const dateTo = dom.fDateTo.value ? new Date(dom.fDateTo.value + "T23:59:59") : null;
    const timeFrom = dom.fTimeFrom.value ? toMinutes(dom.fTimeFrom.value) : null;
    const timeTo = dom.fTimeTo.value ? toMinutes(dom.fTimeTo.value) : null;
    const colegio = dom.fColegio.value;
    const search = dom.fSearch.value.trim().toLowerCase();

    state.filtered = state.raw.filter(r => {
      if (dateFrom && (!r.fechaDate || r.fechaDate < dateFrom)) return false;
      if (dateTo && (!r.fechaDate || r.fechaDate > dateTo)) return false;
      if (timeFrom !== null && (r.horaMinutes === null || r.horaMinutes < timeFrom)) return false;
      if (timeTo !== null && (r.horaMinutes === null || r.horaMinutes > timeTo)) return false;
      if (colegio && r.colegio !== colegio) return false;
      if (search) {
        const hay = `${r.codigo} ${r.participante}`.toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });

    renderAll();
  }

  function toMinutes(hhmm) {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + m;
  }

  function clearFilters() {
    dom.fDateFrom.value = "";
    dom.fDateTo.value = "";
    dom.fTimeFrom.value = "";
    dom.fTimeTo.value = "";
    dom.fColegio.value = "";
    dom.fSearch.value = "";
    applyFilters();
  }

  /* =========================================================
     AGGREGATIONS
     ========================================================= */
  function computeAggregates(data) {
    const bySchoolParticipants = new Map(); // colegio -> Set(participante)
    const bySchoolRegs = new Map();          // colegio -> count registros
    const byDate = new Map();                // fechaStr -> count
    const byHour = new Array(24).fill(0);

    data.forEach(r => {
      if (!bySchoolParticipants.has(r.colegio)) bySchoolParticipants.set(r.colegio, new Set());
      bySchoolParticipants.get(r.colegio).add(r.participante);

      bySchoolRegs.set(r.colegio, (bySchoolRegs.get(r.colegio) || 0) + 1);

      const dKey = r.fechaDate ? formatDate(r.fechaDate) : r.fechaStr;
      byDate.set(dKey, (byDate.get(dKey) || 0) + 1);

      if (r.horaMinutes !== null) {
        byHour[Math.floor(r.horaMinutes / 60)]++;
      }
    });

    const schoolRanking = Array.from(bySchoolParticipants.entries())
      .map(([colegio, set]) => ({ colegio, participantes: set.size, registros: bySchoolRegs.get(colegio) || 0 }))
      .sort((a, b) => b.participantes - a.participantes);

    const dateSeries = Array.from(byDate.entries())
      .map(([fecha, count]) => ({ fecha, count, sortKey: parseFlexibleDate(fecha) }))
      .sort((a, b) => (a.sortKey && b.sortKey) ? a.sortKey - b.sortKey : a.fecha.localeCompare(b.fecha));

    const uniqueParticipants = new Set(data.map(r => `${r.colegio}::${r.participante}`)).size;

    return { schoolRanking, dateSeries, byHour, uniqueParticipants };
  }

  /* =========================================================
     RENDER
     ========================================================= */
  function renderAll() {
    const data = state.filtered;
    const agg = computeAggregates(data);

    renderKpis(data, agg);
    renderTable(data);
    renderCharts(agg);
  }

  function renderKpis(data, agg) {
    const leader = agg.schoolRanking[0];
    dom.kpiLeaderSchool.textContent = leader ? leader.colegio : "—";
    dom.kpiLeaderCount.textContent = leader ? `${leader.participantes} participante${leader.participantes === 1 ? "" : "s"} · ${leader.registros} registro${leader.registros === 1 ? "" : "s"}` : "sin datos en el rango";

    dom.kpiTotalRegs.textContent = data.length.toLocaleString("es-BO");
    dom.kpiUniqueParticipants.textContent = agg.uniqueParticipants.toLocaleString("es-BO");
    dom.kpiTotalSchools.textContent = agg.schoolRanking.length.toLocaleString("es-BO");
  }

  function renderTable(data) {
    dom.tableCount.textContent = `${data.length.toLocaleString("es-BO")} fila${data.length === 1 ? "" : "s"}`;
    const rows = data.slice(0, 500); // cap render for performance
    dom.tableBody.innerHTML = rows.map(r => `
      <tr>
        <td class="codigo-cell">${escapeHtml(r.codigo)}</td>
        <td>${escapeHtml(r.colegio)}</td>
        <td>${escapeHtml(r.participante)}</td>
        <td class="mono">${escapeHtml(r.fechaStr)}</td>
        <td class="mono">${escapeHtml(r.horaStr)}</td>
        <td>${escapeHtml(r.registro)}</td>
      </tr>
    `).join("") || `<tr><td colspan="6" style="text-align:center;color:var(--ink-40);padding:24px;">Sin registros para estos filtros.</td></tr>`;
  }

  const PALETTE = ["#16213C", "#BE4A3C", "#2F6F6B", "#E8C468", "#6FA6A2", "#93342A", "#C79A2E", "#5B6B8C", "#8AA6A3", "#D98C6B"];

  function destroyChart(key) {
    if (state.charts[key]) { state.charts[key].destroy(); state.charts[key] = null; }
  }

  function renderCharts(agg) {
    if (typeof Chart === "undefined") {
      console.error("Chart.js no se cargó (vendor/chart.umd.js). Los gráficos no se mostrarán, pero KPIs y tabla siguen funcionando.");
      showBanner("Los gráficos no se pudieron cargar porque falta el archivo <strong>vendor/chart.umd.js</strong>. Verifica que la carpeta <strong>vendor</strong> esté junto a index.html. Mientras tanto, los indicadores y la tabla siguen funcionando con normalidad.");
      return;
    }
    renderRankingChart(agg.schoolRanking.slice(0, 10));
    renderDateChart(agg.dateSeries);
    renderHourChart(agg.byHour);
    renderShareChart(agg.schoolRanking);
  }

  function renderRankingChart(rows) {
    destroyChart("ranking");
    const ctx = document.getElementById("chartRanking");
    state.charts.ranking = new Chart(ctx, {
      type: "bar",
      data: {
        labels: rows.map(r => r.colegio),
        datasets: [{
          label: "Participantes",
          data: rows.map(r => r.participantes),
          backgroundColor: rows.map((_, i) => i === 0 ? "#BE4A3C" : "#16213C"),
          borderRadius: 6,
          maxBarThickness: 28,
        }]
      },
      options: {
        indexAxis: "y",
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: {
          label: (c) => ` ${c.parsed.x} participantes · ${rows[c.dataIndex].registros} registros`
        } } },
        scales: {
          x: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: "#EAE5D6" } },
          y: { grid: { display: false } }
        }
      }
    });
    if (!rows.length) emptyCanvasNote(ctx);
  }

  function renderDateChart(series) {
    destroyChart("byDate");
    const ctx = document.getElementById("chartByDate");
    state.charts.byDate = new Chart(ctx, {
      type: "line",
      data: {
        labels: series.map(s => s.fecha),
        datasets: [{
          label: "Registros",
          data: series.map(s => s.count),
          borderColor: "#2F6F6B",
          backgroundColor: "rgba(47,111,107,.14)",
          fill: true, tension: .3, pointRadius: 3, pointBackgroundColor: "#2F6F6B",
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false }, ticks: { maxRotation: 45, minRotation: 0 } },
          y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: "#EAE5D6" } }
        }
      }
    });
  }

  function renderHourChart(byHour) {
    destroyChart("byHour");
    const ctx = document.getElementById("chartByHour");
    const labels = byHour.map((_, h) => `${String(h).padStart(2, "0")}h`);
    state.charts.byHour = new Chart(ctx, {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: "Registros",
          data: byHour,
          backgroundColor: "#E8C468",
          borderRadius: 4,
          maxBarThickness: 18,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false }, ticks: { autoSkip: true, maxTicksLimit: 12 } },
          y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: "#EAE5D6" } }
        }
      }
    });
  }

  function renderShareChart(ranking) {
    destroyChart("share");
    const ctx = document.getElementById("chartShare");
    const top5 = ranking.slice(0, 5);
    const othersCount = ranking.slice(5).reduce((sum, r) => sum + r.registros, 0);
    const labels = top5.map(r => r.colegio).concat(othersCount > 0 ? ["Otros colegios"] : []);
    const data = top5.map(r => r.registros).concat(othersCount > 0 ? [othersCount] : []);

    state.charts.share = new Chart(ctx, {
      type: "doughnut",
      data: {
        labels,
        datasets: [{
          data,
          backgroundColor: labels.map((_, i) => i === labels.length - 1 && othersCount > 0 ? "#D9D2BE" : PALETTE[i % PALETTE.length]),
          borderColor: "#fff",
          borderWidth: 2,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        cutout: "62%",
        plugins: { legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 11 } } } }
      }
    });
  }

  function emptyCanvasNote(ctx) {
    // Chart.js already renders empty axes; nothing extra needed, kept as hook for future notes.
  }

  /* =========================================================
     CSV EXPORT
     ========================================================= */
  function exportCsv() {
    const rows = state.filtered;
    const header = ["CODIGO", "COLEGIO", "PARTICIPANTE", "FECHA", "HORA", "REGISTRO"];
    const csvRows = [header.join(",")].concat(
      rows.map(r => [r.codigo, r.colegio, r.participante, r.fechaStr, r.horaStr, r.registro]
        .map(v => `"${String(v).replace(/"/g, '""')}"`).join(","))
    );
    const blob = new Blob([csvRows.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `registros_filtrados_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /* =========================================================
     UI: STATUS / BANNER
     ========================================================= */
  function setConnStatus(status) {
    dom.connStatus.classList.remove("status-pill--ok");
    if (status === "ok") {
      dom.connStatus.classList.add("status-pill--ok");
      dom.connText.textContent = "Conectado";
      dom.dashMain.hidden = false;
    } else if (status === "loading") {
      dom.connText.textContent = "Leyendo hoja…";
    } else {
      dom.connText.textContent = "Error de conexión";
    }
  }

  function showBanner(html) {
    dom.dataBannerText.innerHTML = html;
    dom.dataBanner.hidden = false;
  }
  function hideBanner() {
    dom.dataBanner.hidden = true;
  }

  /* =========================================================
     SETTINGS MODAL
     ========================================================= */
  function openSettings() {
    dom.cfgSheetId.value = state.config.sheetId || "";
    dom.cfgSheetName.value = state.config.sheetRef || "";
    dom.cfgAutoSeconds.value = String(state.config.autoSeconds || 60);
    dom.settingsError.hidden = true;
    dom.settingsOverlay.hidden = false;
    dom.cfgSheetId.focus();
  }
  function closeSettings() {
    dom.settingsOverlay.hidden = true;
  }
  function saveSettings() {
    const sheetId = dom.cfgSheetId.value.trim();
    if (!sheetId) {
      dom.settingsError.textContent = "Ingresa el ID de la hoja de cálculo.";
      dom.settingsError.hidden = false;
      return;
    }
    state.config.sheetId = sheetId;
    state.config.sheetRef = dom.cfgSheetName.value.trim();
    state.config.autoSeconds = Number(dom.cfgAutoSeconds.value);
    saveConfig();
    closeSettings();
    setupAutoRefresh();
    fetchSheet();
  }

  /* =========================================================
     AUTO REFRESH
     ========================================================= */
  function setupAutoRefresh() {
    if (state.autoTimer) clearInterval(state.autoTimer);
    if (dom.autoToggle.checked) {
      state.autoTimer = setInterval(fetchSheet, Math.max(15, state.config.autoSeconds || 60) * 1000);
    }
  }

  /* =========================================================
     EVENTS
     ========================================================= */
  function bindEvents() {
    dom.refreshBtn.addEventListener("click", fetchSheet);
    dom.settingsBtn.addEventListener("click", openSettings);
    dom.settingsClose.addEventListener("click", closeSettings);
    dom.settingsCancel.addEventListener("click", closeSettings);
    dom.settingsSave.addEventListener("click", saveSettings);
    dom.settingsOverlay.addEventListener("click", (e) => { if (e.target === dom.settingsOverlay) closeSettings(); });

    dom.applyFilters.addEventListener("click", applyFilters);
    dom.clearFilters.addEventListener("click", clearFilters);
    dom.exportCsv.addEventListener("click", exportCsv);
    dom.fSearch.addEventListener("keydown", (e) => { if (e.key === "Enter") applyFilters(); });

    dom.autoToggle.addEventListener("change", setupAutoRefresh);
  }

  /* =========================================================
     INIT
     ========================================================= */
  function init() {
    loadConfig();
    bindEvents();
    if (state.config.sheetId) {
      fetchSheet();
      setupAutoRefresh();
    } else {
      showBanner("Aún no hay una hoja conectada. Pulsa <strong>⚙ Fuente</strong> para ingresar el ID de tu Google Sheet.");
      openSettings();
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
