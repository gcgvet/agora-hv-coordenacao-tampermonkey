// ==UserScript==
// @name         Ágora HV - Coordenação
// @namespace    https://agoraveterinaria.com.br/
// @version      0.5.12-test
// @description  Revisão, pendências e painel da coordenação veterinária.
// @author       Ágora Clínica Veterinária
// @match        https://ciplexsistemas.com/sistema/*
// @match        file:///*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @updateURL    https://raw.githubusercontent.com/gcgvet/agora-hv-coordenacao-tampermonkey/sidebar-coordenacao/agora-hv-coordenacao.user.js
// @downloadURL  https://raw.githubusercontent.com/gcgvet/agora-hv-coordenacao-tampermonkey/sidebar-coordenacao/agora-hv-coordenacao.user.js
// ==/UserScript==

(function () {
  "use strict";

  const WEB_APP_URL = "https://script.google.com/macros/s/AKfycbyYjJIoUHUspHeZCUoZb_tnupYF6_cI3qeQGxSGAtjR7F5EaHmbGpIiezPwbzzqR-jcow/exec";
  const CATEGORIES = ["Documental", "Assistencial/Operacional", "Comunicação Interna", "Comunicação Externa", "Processual"];
  const STATUSES = ["Aberta", "Comunicada", "Em regularização", "Resolvida", "Encerrada"];
  const CONSULTATION_CRITERIA = [
    { key: "completude", label: "Completude", category: "Documental" },
    { key: "suficiencia", label: "Suficiência", category: "Assistencial/Operacional" },
    { key: "coerencia", label: "Coerência", category: "Assistencial/Operacional" },
    { key: "documentacao", label: "Documentação", category: "Documental" }
  ];
  const SITE_PAGE = /\/(?:index\.html)?$/i;
  let consultationRecords = [];
  let dashboardPendencies = [];
  const ciplexPatientClients = new Map();
  const ciplexNamesLinks = new Map();
  const ciplexLookupRequests = new Map();
  let dashboardHistoryCache = null;
  let dashboardHistoryRequest = null;
  let dashboardHistoryGeneration = 0;
  let dashboardSort = { key: null, direction: 1 };
  let loadingOperations = 0;
  let backgroundSaveCount = 0;
  let activePanelHistory = null;

  if (location.protocol === "file:" && SITE_PAGE.test(location.pathname)) initializeHospitalReview();
  if (location.origin === "https://ciplexsistemas.com") {
    initializeCoordinationSidebar();
    new MutationObserver(() => {
      initializeCoordinationSidebar();
    }).observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener("popstate", handleCoordinationHistory);
  }

  function initializeHospitalReview() {
    const toolbar = document.querySelector(".toolbar-actions");
    const patientForm = document.querySelector("#patient-form");
    if (!toolbar || !patientForm || document.querySelector("#agora-review-patient")) return;

    injectStyles();
    const dashboardButton = createButton("Painel coordenação", "agora-open-dashboard", "secondary", openCoordinationDashboard);
    const pendingButton = createButton("Pendências", "agora-pending-patient", "secondary", openPatientPendencies);
    const reviewButton = createButton("Revisar internação", "agora-review-patient", "primary", openReviewModal);
    toolbar.prepend(dashboardButton, pendingButton, reviewButton);
  }

  function createButton(label, id, className, handler) {
    const button = document.createElement("button");
    button.type = "button";
    button.id = id;
    button.className = className;
    button.textContent = label;
    button.addEventListener("click", handler);
    return button;
  }

  function currentPatient() {
    const form = document.querySelector("#patient-form");
    if (!form?.dataset.pacienteId) throw new Error("Selecione uma internação antes de revisar.");
    return {
      pacienteId: form.dataset.pacienteId,
      ciplexAnimalId: form.dataset.ciplexAnimalId || "",
      paciente: form.elements.name?.value.trim() || form.dataset.pacienteName || "",
      tutor: form.elements.tutor?.value.trim() || "",
      veterinario: form.elements.veterinarians?.value.trim() || form.dataset.veterinarian || ""
    };
  }

  function openReviewModal() {
    let patient;
    try {
      patient = currentPatient();
    } catch (error) {
      notify(error.message, true);
      return;
    }

    const overlay = createOverlay("Registrar pendência da internação");
    overlay.querySelector(".agora-modal-body").innerHTML = `
      <div class="agora-context"><strong>${escapeHTML(patient.paciente || "Paciente")}</strong><span>${escapeHTML(patient.veterinario || "Veterinário não informado")}</span></div>
      <form id="agora-review-form">
        <label>Categoria<select name="categoria" required>${CATEGORIES.map(item => `<option>${escapeHTML(item)}</option>`).join("")}</select></label>
        <label>Descrição<textarea name="descricao" rows="4" required maxlength="1000"></textarea></label>
        <div class="agora-grid"><label>Responsável<input name="responsavel" maxlength="100"></label><label>Prazo<input name="prazo" type="date"></label></div>
        <label>Observação inicial<textarea name="observacao" rows="2" maxlength="1000"></textarea></label>
        <div class="agora-actions"><button type="button" data-close>Cancelar</button><button type="submit" class="agora-primary">Registrar pendência</button></div>
      </form>`;
    document.body.append(overlay);
    overlay.querySelector("textarea").focus();
    overlay.querySelector("#agora-review-form").addEventListener("submit", event => createPendencia(event, patient, overlay));
  }

  async function createPendencia(event, patient, overlay) {
    event.preventDefault();
    const submit = event.submitter;
    if (submit.disabled) return;
    submit.disabled = true;
    submit.textContent = "Registrando...";
    const data = new FormData(event.currentTarget);
    try {
      await apiRequest("createPendencia", { pendencia: {
        ...patient,
        categoria: data.get("categoria"),
        origem: "Internação",
        descricao: data.get("descricao").trim(),
        responsavel: data.get("responsavel").trim(),
        prazo: data.get("prazo"),
        status: "Aberta",
        observacoes: data.get("observacao").trim(),
        observacao: data.get("observacao").trim(),
        usuario: "Coordenadora"
      } });
      overlay.remove();
      notify("Pendência registrada.");
    } catch (error) {
      notify(error.message, true);
      submit.disabled = false;
      submit.textContent = "Registrar pendência";
    }
  }

  async function openPatientPendencies(background = false) {
    let patient;
    try {
      patient = currentPatient();
    } catch (error) {
      notify(error.message, true);
      return;
    }
    const button = document.querySelector("#agora-pending-patient");
    button.disabled = true;
    try {
      const result = await apiRequest("listPendencias", {}, { blocking: !background });
      const pendencies = result.pendencias.filter(item => item.pacienteId === patient.pacienteId || (patient.ciplexAnimalId && item.ciplexAnimalId === patient.ciplexAnimalId));
      renderPendencies(patient, pendencies);
    } catch (error) {
      notify(error.message, true);
    } finally {
      button.disabled = false;
    }
  }

  function renderPendencies(patient, pendencies) {
    const overlay = createOverlay(`Pendências de ${patient.paciente || "paciente"}`, true);
    const openCount = pendencies.filter(item => !["Resolvida", "Encerrada"].includes(item.status)).length;
    const overdueCount = pendencies.filter(isOverdue).length;
    overlay.querySelector(".agora-modal-body").innerHTML = `
      <div class="agora-indicators"><span><b>${pendencies.length}</b>Total</span><span><b>${openCount}</b>Em andamento</span><span class="${overdueCount ? "danger" : ""}"><b>${overdueCount}</b>Vencidas</span></div>
      <div class="agora-pending-list">${pendencies.length ? pendencies.map(pendingCard).join("") : "<p>Nenhuma pendência registrada para esta internação.</p>"}</div>`;
    document.body.append(overlay);
    overlay.querySelectorAll("[data-update-pending]").forEach(button => button.addEventListener("click", updatePending));
    overlay.querySelectorAll("[data-history-pending]").forEach(button => button.addEventListener("click", showHistory));
  }

  function pendingCard(item) {
    const origin = pendencyOrigin(item);
    const observationMeta = [item.ultimaObservacaoEm ? formatDateTime(item.ultimaObservacaoEm) : "", item.ultimaObservacaoUsuario].filter(Boolean).join(" · ");
    return `<article class="agora-pending-card ${isOverdue(item) ? "overdue" : ""}" data-pending-id="${escapeHTML(item.id)}">
      <header><span>${escapeHTML(item.categoria)}</span><i class="agora-origin ${origin === "Internação" ? "hospital" : "consultation"}">${escapeHTML(origin)}</i>${item.codigo ? `<code>#${escapeHTML(item.codigo)}</code>` : ""}<b>${escapeHTML(item.status)}</b>${item.reincidente === true || item.reincidente === "true" ? "<em>Reincidente</em>" : ""}</header>
      <p>${escapeHTML(item.descricao)}</p>
      <small>${item.prazo ? `Prazo: ${escapeHTML(formatDate(item.prazo))}` : "Sem prazo"}${item.responsavel ? ` · Responsável: ${escapeHTML(item.responsavel)}` : ""}</small>
      ${item.ultimaObservacao ? `<div class="agora-latest-observation"><b>Última observação</b><p>${escapeHTML(item.ultimaObservacao)}</p>${observationMeta ? `<small>${escapeHTML(observationMeta)}</small>` : ""}</div>` : ""}
      <div class="agora-grid"><label>Status<select data-status>${STATUSES.map(status => `<option ${status === item.status ? "selected" : ""}>${escapeHTML(status)}</option>`).join("")}</select></label><label>Observação<input data-observation maxlength="1000"></label></div>
      <div class="agora-actions"><button type="button" data-history-pending="${escapeHTML(item.id)}">Histórico</button><button type="button" class="agora-primary" data-update-pending="${escapeHTML(item.id)}">Salvar alteração</button></div>
      <div class="agora-history" hidden></div>
    </article>`;
  }

  async function updatePending(event) {
    const button = event.currentTarget;
    if (button.disabled) return;
    const card = button.closest("[data-pending-id]");
    const status = card.querySelector("[data-status]").value;
    const observation = card.querySelector("[data-observation]").value.trim();
    button.disabled = true;
    runBackgroundSave(() => apiRequest("updatePendencia", { pendencia: {
      id: button.dataset.updatePending, status, observacao: observation, usuario: "Coordenadora"
    } }, { blocking: false })).then(() => {
      notify("Pendência atualizada.");
      openPatientPendencies(true);
    }).catch(error => {
      notify(error.message, true);
      button.disabled = false;
    });
  }

  async function showHistory(event) {
    const button = event.currentTarget;
    const card = button.closest("[data-pending-id]");
    const container = card.querySelector(".agora-history");
    if (!container.hidden) {
      container.hidden = true;
      return;
    }
    button.disabled = true;
    try {
      const pendingId = button.dataset.historyPending;
      const result = card.closest(".agora-overlay[data-dashboard-pending]")
        ? { historico: (await loadDashboardHistory()).filter(item => String(item.pendenciaId) === pendingId) }
        : await apiRequest("listHistorico", { pendenciaId: pendingId });
      container.innerHTML = result.historico.length ? result.historico.map(item => `<div><b>${escapeHTML(formatDateTime(item.data))}</b> ${escapeHTML(item.acao)}${item.statusNovo ? ` · ${escapeHTML(item.statusNovo)}` : ""}${item.observacao ? `<p>${escapeHTML(item.observacao)}</p>` : ""}</div>`).join("") : "<div>Sem histórico.</div>";
      container.hidden = false;
    } catch (error) {
      notify(error.message, true);
    } finally {
      button.disabled = false;
    }
  }

  function createOverlay(title, wide = false) {
    document.querySelector(".agora-overlay")?.remove();
    const overlay = document.createElement("div");
    overlay.className = "agora-overlay";
    overlay.innerHTML = `<section class="agora-modal ${wide ? "wide" : ""}"><header><h2>${escapeHTML(title)}</h2><button type="button" data-close aria-label="Fechar">×</button></header><div class="agora-modal-body"></div></section>`;
    overlay.addEventListener("click", event => {
      if (event.target === overlay || event.target.closest("[data-close]")) overlay.remove();
    });
    return overlay;
  }

  function apiRequest(action, payload = {}, options = {}) {
    const messages = {
      createPendencia: "Registrando pendência...",
      listPendencias: "Carregando pendências...",
      updatePendencia: "Salvando alteração...",
      listHistorico: "Carregando histórico...",
      export: "Preparando exportação..."
    };
    const request = () => new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "POST",
        url: WEB_APP_URL,
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        data: JSON.stringify({ action, ...payload }),
        timeout: options.timeout || 20000,
        onload(response) {
          let result;
          try {
            result = JSON.parse(response.responseText);
          } catch {
            reject(new Error("O Apps Script retornou uma resposta inválida."));
            return;
          }
          if (response.status < 200 || response.status >= 300 || !result.ok) reject(new Error(result.error || "Não foi possível concluir a operação."));
          else resolve(result);
        },
        ontimeout() { const error = new Error("O Apps Script não respondeu a tempo."); error.code = "TIMEOUT"; reject(error); },
        onerror() { reject(new Error("Não foi possível acessar o Apps Script.")); }
      });
    });
    return options.blocking === false ? request() : withLoading(messages[action] || "Processando dados...", request);
  }

  async function withLoading(message, operation) {
    injectStyles();
    let overlay = document.querySelector("#agora-loading-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "agora-loading-overlay";
      overlay.setAttribute("role", "status");
      overlay.setAttribute("aria-live", "assertive");
      overlay.innerHTML = `<div><i aria-hidden="true"></i><strong></strong><small>Aguarde a conclusão para continuar.</small></div>`;
      document.body.append(overlay);
    }
    loadingOperations += 1;
    overlay.querySelector("strong").textContent = message;
    overlay.classList.add("visible");
    document.body.setAttribute("aria-busy", "true");
    try {
      return await operation();
    } finally {
      loadingOperations -= 1;
      if (!loadingOperations) {
        overlay.classList.remove("visible");
        document.body.removeAttribute("aria-busy");
      }
    }
  }

  function isOverdue(item) {
    return Boolean(item.prazo && item.prazo < todayISO() && !["Resolvida", "Encerrada"].includes(item.status));
  }

  function todayISO() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }

  function formatDate(value) {
    const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
    return match ? `${match[3]}/${match[2]}/${match[1]}` : String(value || "");
  }

  function formatDateTime(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value || "") : date.toLocaleString("pt-BR");
  }

  function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>'"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
  }

  function notify(message, error = false) {
    const notice = document.createElement("div");
    notice.className = `agora-notice ${error ? "error" : ""}`;
    notice.textContent = message;
    document.body.append(notice);
    setTimeout(() => notice.remove(), error ? 7000 : 3500);
  }

  function initializeCoordinationSidebar() {
    const sidebar = document.querySelector("#sidebar");
    const nav = sidebar?.querySelector("ul.nav.nav-list");
    const collapse = sidebar?.querySelector("#sidebar-collapse");
    if (!nav || !collapse) return;
    if (!document.querySelector("#agora-sidebar-dashboard")) {
      nav.appendChild(createSidebarAction("Painel coordenação", "agora-sidebar-dashboard", "fa-clipboard-check", openCoordinationDashboard));
    }
    if (!document.querySelector("#agora-sidebar-consultations")) {
      nav.appendChild(createSidebarAction("Revisão consultas", "agora-sidebar-consultations", "fa-stethoscope", openConsultationControl));
    }
  }

  function beginPanelHistory(panel) {
    if (activePanelHistory) return;
    history.pushState({ ...(history.state || {}), agoraCoordPanel: panel }, "", location.href);
    activePanelHistory = panel;
  }

  function closeCoordinationPanel(restoreHistory = false) {
    if (backgroundSaveCount > 0) {
      notify("Aguarde o salvamento terminar antes de sair.", true);
      return false;
    }
    const hadPanel = Boolean(document.querySelector("#agora-dashboard-root, #agora-consultations-root"));
    document.querySelectorAll("#agora-dashboard-root, #agora-consultations-root, .agora-overlay").forEach(element => element.remove());
    if (restoreHistory && hadPanel && activePanelHistory) {
      activePanelHistory = null;
      history.back();
    }
    return true;
  }

  function switchCoordinationPanel(openPanel) {
    if (closeCoordinationPanel()) openPanel();
  }

  function handleCoordinationHistory() {
    if (backgroundSaveCount > 0) {
      history.pushState({ ...(history.state || {}), agoraCoordPanel: activePanelHistory || "coordination" }, "", location.href);
      notify("Aguarde o salvamento terminar antes de sair.", true);
      return;
    }
    if (!activePanelHistory) return;
    activePanelHistory = null;
    closeCoordinationPanel();
  }

  function updateSavingIndicator() {
    let indicator = document.querySelector("#agora-saving-indicator");
    if (backgroundSaveCount > 0) {
      if (!indicator) {
        indicator = document.createElement("div");
        indicator.id = "agora-saving-indicator";
        indicator.setAttribute("role", "status");
        indicator.setAttribute("aria-live", "polite");
        document.body.append(indicator);
      }
      indicator.innerHTML = '<span aria-hidden="true"></span> Salvando alterações...';
      indicator.classList.add("visible");
    } else if (indicator) {
      indicator.classList.remove("visible");
    }
  }

  function runBackgroundSave(operation) {
    backgroundSaveCount += 1;
    updateSavingIndicator();
    return Promise.resolve().then(operation).finally(() => {
      backgroundSaveCount = Math.max(0, backgroundSaveCount - 1);
      updateSavingIndicator();
    });
  }

  function createSidebarAction(label, id, icon, handler) {
    const item = document.createElement("li");
    item.id = id;
    item.className = "hover agora-sidebar-item";
    const link = document.createElement("a");
    link.href = "#";
    link.setAttribute("role", "button");
    link.setAttribute("aria-label", label);
    link.title = label;
    link.innerHTML = `<i class="menu-icon fa ${icon}" aria-hidden="true"></i><span class="menu-text">${escapeHTML(label)}</span>`;
    link.addEventListener("click", event => {
      event.preventDefault();
      handler();
    });
    item.appendChild(link);
    return item;
  }

  async function openCoordinationDashboard() {
    if (document.querySelector("#agora-dashboard-root")) return;
    beginPanelHistory("dashboard");
    const root = document.createElement("section");
    root.id = "agora-dashboard-root";
    root.innerHTML = `<main class="agora-dashboard-page">
      <header><div><h1>Painel da coordenação</h1><p>Pendências de consultas e internações em um único acompanhamento.</p></div><div class="agora-panel-navigation"><button type="button" data-dashboard-consultations>Revisão de consultas</button><button type="button" data-dashboard-close>Fechar</button></div></header>
      <div class="agora-dashboard-filters">
        <label>Buscar<input data-dashboard-search placeholder="Paciente, tutor, veterinário ou descrição"></label>
        <label>Status<select data-dashboard-status><option value="active">Todos ativos</option>${STATUSES.map(item => `<option>${escapeHTML(item)}</option>`).join("")}<option value="all">Todos (inclui Encerradas)</option></select></label>
        <label>Categoria<select data-dashboard-category><option value="">Todas</option>${CATEGORIES.map(item => `<option>${escapeHTML(item)}</option>`).join("")}</select></label>
        <label>Origem<select data-dashboard-origin><option value="">Todas</option><option>Consulta</option><option>Internação</option></select></label>
        <label>Veterinário<select data-dashboard-veterinarian><option value="">Todos</option></select></label>
        <label>Destaque<select data-dashboard-highlight><option value="">Todos</option><option value="overdue">Vencidas</option><option value="recurrent">Reincidentes</option></select></label>
      </div>
      <div class="agora-dashboard-actions"><button type="button" data-dashboard-complete-links>Completar links</button><button type="button" data-dashboard-report>Relatório</button><button type="button" data-dashboard-csv>Exportar CSV</button><button type="button" class="agora-primary" data-dashboard-save-all>Salvar todas</button><button type="button" class="agora-primary" data-dashboard-refresh>Atualizar</button></div>
      <div class="agora-indicators" data-dashboard-indicators></div>
      <div class="agora-dashboard-list" data-dashboard-list><p>Carregando pendências...</p></div>
    </main>`;
    document.body.append(root);
    root.querySelector("[data-dashboard-consultations]").addEventListener("click", () => switchCoordinationPanel(openConsultationControl));
    root.querySelector("[data-dashboard-close]").addEventListener("click", () => closeCoordinationPanel(true));
    root.querySelectorAll(".agora-dashboard-filters input,.agora-dashboard-filters select").forEach(control => control.addEventListener("input", renderDashboard));
    root.querySelector("[data-dashboard-refresh]").addEventListener("click", loadDashboardPendencies);
    root.querySelector("[data-dashboard-complete-links]").addEventListener("click", completeDashboardLinks);
    root.querySelector("[data-dashboard-report]").addEventListener("click", openDashboardReport);
    root.querySelector("[data-dashboard-csv]").addEventListener("click", () => exportOperationalData("csv"));
    root.querySelector("[data-dashboard-save-all]").addEventListener("click", saveAllDashboardPending);
    await loadDashboardPendencies();
  }

  async function loadDashboardPendencies(background = false) {
    const root = document.querySelector("#agora-dashboard-root");
    if (!root) return;
    const refresh = root.querySelector("[data-dashboard-refresh]");
    refresh.disabled = true;
    invalidateDashboardHistory();
    loadDashboardHistory().catch(() => {});
    try {
      const result = await apiRequest("listPendencias", {}, { blocking: !background });
      dashboardPendencies = result.pendencias;
      rememberConsultationLinks(consultationRecords);
      updateDashboardVeterinarians();
      renderDashboard();
      hydrateDashboardLinks().catch(error => notify("Não foi possível carregar os links do Ciplex: " + error.message, true));
    } catch (error) {
      notify(error.message, true);
    } finally {
      refresh.disabled = false;
    }
  }

  function invalidateDashboardHistory() {
    dashboardHistoryGeneration += 1;
    dashboardHistoryCache = null;
    dashboardHistoryRequest = null;
  }

  function loadDashboardHistory() {
    if (dashboardHistoryCache !== null) return Promise.resolve(dashboardHistoryCache);
    if (dashboardHistoryRequest) return dashboardHistoryRequest;
    const generation = dashboardHistoryGeneration;
    const request = apiRequest("listHistorico", {}, { blocking: false }).then(result => {
      if (generation !== dashboardHistoryGeneration) return loadDashboardHistory();
      dashboardHistoryCache = result.historico;
      return dashboardHistoryCache;
    }).finally(() => {
      if (dashboardHistoryRequest === request) dashboardHistoryRequest = null;
    });
    dashboardHistoryRequest = request;
    return request;
  }

  function updateDashboardVeterinarians() {
    const select = document.querySelector("[data-dashboard-veterinarian]");
    if (!select) return;
    const previous = select.value;
    const names = [...new Set(dashboardPendencies.map(item => item.veterinario?.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR"));
    select.innerHTML = `<option value="">Todos</option>${names.map(name => `<option>${escapeHTML(name)}</option>`).join("")}`;
    if (names.includes(previous)) select.value = previous;
  }

  function filteredDashboardPendencies() {
    const root = document.querySelector("#agora-dashboard-root");
    if (!root) return [];
    const search = normalizeText(root.querySelector("[data-dashboard-search]").value);
    const status = root.querySelector("[data-dashboard-status]").value;
    const category = root.querySelector("[data-dashboard-category]").value;
    const origin = root.querySelector("[data-dashboard-origin]").value;
    const veterinarian = root.querySelector("[data-dashboard-veterinarian]").value;
    const highlight = root.querySelector("[data-dashboard-highlight]").value;
    return dashboardPendencies.filter(item => {
      const searchable = normalizeText([item.codigo, item.id, item.ciplexAnimalId, item.paciente, item.tutor, item.veterinario, item.descricao, item.responsavel, item.ultimaObservacao].join(" "));
      return (!search || searchable.includes(search))
        && (status === "all" || status === "active" && item.status !== "Encerrada" || item.status === status)
        && (!category || item.categoria === category)
        && (!origin || pendencyOrigin(item) === origin)
        && (!veterinarian || item.veterinario === veterinarian)
        && (!highlight || highlight === "overdue" && isOverdue(item) || highlight === "recurrent" && (item.reincidente === true || item.reincidente === "true"));
    }).sort(compareDashboardPendencies);
  }

  function renderDashboard() {
    const root = document.querySelector("#agora-dashboard-root");
    if (!root) return;
    const items = filteredDashboardPendencies();
    const active = items.filter(item => !["Resolvida", "Encerrada"].includes(item.status)).length;
    const overdue = items.filter(isOverdue).length;
    const recurrent = items.filter(item => item.reincidente === true || item.reincidente === "true").length;
    root.querySelector("[data-dashboard-indicators]").innerHTML = `<span><b>${items.length}</b>Exibidas</span><span><b>${active}</b>Em andamento</span><span class="${overdue ? "danger" : ""}"><b>${overdue}</b>Vencidas</span><span><b>${recurrent}</b>Reincidentes</span>`;
    const list = root.querySelector("[data-dashboard-list]");
    const columns = [["date", "Data"], ["veterinario", "Veterinário"], ["paciente", "Animal"], ["tutor", "Cliente"], ["origin", "Origem"], [null, "Pendência"], ["status", "Status"]];
    list.innerHTML = `<div class="agora-dashboard-table"><table><thead><tr>${columns.map(([key, label]) => {
      const selected = dashboardSort.key === key && key;
      return `<th${key ? ` aria-sort="${selected ? dashboardSort.direction === 1 ? "ascending" : "descending" : "none"}"` : ""}>${key ? `<button type="button" data-dashboard-sort="${key}">${label}<span aria-hidden="true">${selected ? dashboardSort.direction === 1 ? " ▲" : " ▼" : " ↕"}</span></button>` : label}</th>`;
    }).join("")}</tr></thead><tbody>${items.length ? items.map(dashboardPendingRow).join("") : '<tr><td colspan="7" class="agora-consultation-empty">Nenhuma pendência corresponde aos filtros.</td></tr>'}</tbody></table></div>`;
    list.querySelectorAll("[data-dashboard-sort]").forEach(button => button.addEventListener("click", () => {
      const key = button.dataset.dashboardSort;
      dashboardSort = { key, direction: dashboardSort.key === key ? -dashboardSort.direction : 1 };
      renderDashboard();
    }));
    list.querySelectorAll("[data-open-pending]").forEach(button => button.addEventListener("click", openDashboardPending));
  }

  function pendingDate(item) {
    return item.criadoEm || item.criadaEm || item.dataCriacao || item.data || "";
  }

  function dashboardSortValue(item, key) {
    if (key === "date") {
      const value = pendingDate(item);
      const brazilian = String(value).match(/^(\d{2})\/(\d{2})\/(\d{4})/);
      const timestamp = new Date(brazilian ? `${brazilian[3]}-${brazilian[2]}-${brazilian[1]}` : value).getTime();
      return Number.isNaN(timestamp) ? null : timestamp;
    }
    if (key === "origin") return pendencyOrigin(item);
    return item[key] || "";
  }

  function compareDashboardPendencies(first, second) {
    if (!dashboardSort.key) return Number(isOverdue(second)) - Number(isOverdue(first)) || String(first.prazo || "9999").localeCompare(String(second.prazo || "9999"));
    const a = dashboardSortValue(first, dashboardSort.key);
    const b = dashboardSortValue(second, dashboardSort.key);
    if (a === null || a === "") return b === null || b === "" ? 0 : 1;
    if (b === null || b === "") return -1;
    return dashboardSort.direction * (typeof a === "number" ? a - b : String(a).localeCompare(String(b), "pt-BR", { sensitivity: "base", numeric: true }));
  }



  function rememberConsultationLinks(records) {
    records.forEach(record => {
      if (/^\d+$/.test(String(record.pacienteId)) && /^\d+$/.test(String(record.clienteId))) {
        ciplexPatientClients.set(String(record.pacienteId), String(record.clienteId));
        const key = `${normalizeText(record.animal)}|${normalizeText(record.cliente)}`;
        const links = ciplexNamesLinks.get(key) || new Map();
        links.set(`${record.pacienteId}|${record.clienteId}`, { animalId: String(record.pacienteId), clientId: String(record.clienteId) });
        ciplexNamesLinks.set(key, links);
      }
    });
  }

  function clientIdFromSearch(html, animalId) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const candidates = new Set();
    const exact = new Set();
    doc.querySelectorAll("a[href]").forEach(link => {
      const url = safeCiplexUrl(link.getAttribute("href"));
      if (!url) return;
      const ids = extractCiplexIds(url);
      if (!ids.clienteId) return;
      if (ids.pacienteId && ids.pacienteId !== String(animalId)) return;
      candidates.add(ids.clienteId);
      if (ids.pacienteId === String(animalId)) exact.add(ids.clienteId);
    });
    if (exact.size === 1) return [...exact][0];
    if (!exact.size && candidates.size === 1) return [...candidates][0];
    throw new Error(candidates.size ? "A busca retornou mais de um cliente possível." : "Nenhum link de cliente encontrado na resposta do Ciplex.");
  }

  function lookupCiplexClient(animalId) {
    animalId = String(animalId);
    if (!/^\d+$/.test(animalId)) return Promise.reject(new Error("ID do animal inválido."));
    if (ciplexPatientClients.has(animalId)) return Promise.resolve(ciplexPatientClients.get(animalId));
    if (ciplexLookupRequests.has(animalId)) return ciplexLookupRequests.get(animalId);
    const request = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      try {
        const query = new URLSearchParams({ pagina: "1", pesquisa: animalId, campo: "idAnimal" });
        const response = await fetch("/sistema/clientes/listar?" + query, { credentials: "include", headers: { "X-Requested-With": "XMLHttpRequest" }, signal: controller.signal });
        if (!response.ok) throw new Error("Falha na busca Ciplex: " + response.status);
        const clientId = clientIdFromSearch(await response.text(), animalId);
        ciplexPatientClients.set(animalId, clientId);
        return clientId;
      } finally { clearTimeout(timeout); }
    })().finally(() => ciplexLookupRequests.delete(animalId));
    ciplexLookupRequests.set(animalId, request);
    return request;
  }

  async function hydrateDashboardLinks() {
    if (location.origin !== "https://ciplexsistemas.com") return;
    const animals = [...new Set(dashboardPendencies.map(pendencyCiplexIds).filter(ids => ids.animalId && !ids.clientId).map(ids => ids.animalId))];
    for (const animalId of animals) {
      if (!document.querySelector("#agora-dashboard-root")) break;
      try { await lookupCiplexClient(animalId); } catch { continue; }
      renderDashboard();
    }
  }

  async function completeDashboardLinks(event) {
    const button = event.currentTarget;
    if (button.disabled) return;
    if (location.origin !== "https://ciplexsistemas.com") return notify("Abra o painel dentro do Ciplex para completar os links.", true);
    button.disabled = true;
    let items = [];
    let unattempted = 0;
    let timedOut = false;
    let saved = 0;
    const failures = [];
    try {
      await runBackgroundSave(async () => {
        const health = await apiRequest("health", {}, { blocking: false });
        if (!health.clientLinks) throw new Error("Atualize primeiro a implantação do Apps Script com suporte ao ID do cliente.");
        button.textContent = "Conferindo vínculos salvos...";
        const current = await apiRequest("listPendencias", {}, { blocking: false, timeout: 120000 });
        dashboardPendencies = current.pendencias;
        items = dashboardPendencies.filter(item => !item.ciplexClienteId);
        for (const item of items) {
          button.textContent = `Completando ${saved + failures.length + 1}/${items.length}...`;
          try {
            const { animalId } = pendencyCiplexIds(item);
            if (!animalId) throw new Error("ID do animal ausente.");
            const clientId = await lookupCiplexClient(animalId);
            const result = await apiRequest("linkPendenciaCliente", { pendencia: { id: item.id, ciplexAnimalId: animalId, ciplexClienteId: clientId, usuario: "Coordenadora" } }, { blocking: false, timeout: 120000 });
            if (String(result.pendencia?.ciplexClienteId || "") !== clientId) throw new Error("O serviço não confirmou a gravação.");
            item.ciplexClienteId = clientId;
            saved += 1;
          } catch (error) {
            failures.push(`${item.codigo || item.paciente || item.id}: ${error.message}`);
            if (error.code === "TIMEOUT") {
              timedOut = true;
              unattempted = items.length - saved - failures.length;
              break;
            }
          }
        }
      });
      renderDashboard();
      invalidateDashboardHistory();
      if (!timedOut) loadDashboardHistory().catch(() => {});
      const overlay = createOverlay("Resultado — completar links", true);
      overlay.querySelector(".agora-modal-body").innerHTML = `<p>Gravações confirmadas nesta execução: ${saved}. Sem confirmação ou com erro: ${failures.length}. Não tentados: ${unattempted}.</p>${timedOut ? "<p>A sequência foi interrompida para aguardar o servidor. A última gravação ainda pode ser concluída. Aguarde alguns minutos e clique novamente em Completar links; os vínculos já salvos serão conferidos e ignorados.</p>" : ""}${failures.length ? `<ul>${failures.map(message => `<li>${escapeHTML(message)}</li>`).join("")}</ul>` : ""}<div class="agora-actions"><button type="button" data-close>Fechar</button></div>`;
      document.body.append(overlay);
    } catch (error) { notify(error.message, true); }
    finally { button.disabled = false; button.textContent = "Completar links"; }
  }

  function pendencyCiplexIds(item) {
    const ids = extractCiplexIds([item.clienteUrl, item.animalUrl].filter(Boolean).join(" "));
    const originId = String(item.origemRegistro || "").match(/^consulta:(\d+):/);
    let animalId = String(item.ciplexAnimalId || ids.pacienteId || originId?.[1] || "");
    let clientId = String(item.ciplexClienteId || item.clienteId || ids.clienteId || ciplexPatientClients.get(animalId) || "");
    return { animalId, clientId };
  }

  function pendencyNameLink(name, item, animal) {
    const { animalId, clientId } = pendencyCiplexIds(item);
    const clientUrl = /^\d+$/.test(clientId) ? `https://ciplexsistemas.com/sistema/exibir#clientes/exibir/${clientId}` : "";
    const url = animal ? clientUrl && /^\d+$/.test(animalId) ? `${clientUrl}&Animal.editar=${animalId}` : safeCiplexUrl(item.animalUrl || "") : clientUrl || safeCiplexUrl(item.clienteUrl || "");
    return consultationName(name, url);
  }

  function dashboardPendingRow(item) {
    const statusClass = ["open", "communicated", "regularizing", "resolved", "closed"][STATUSES.indexOf(item.status)] || "open";
    const date = pendingDate(item);
    return `<tr class="${isOverdue(item) ? "agora-dashboard-overdue" : ""}">
      <td>${escapeHTML(date ? formatDate(date) : "—")}</td>
      <td>${escapeHTML(item.veterinario || "Não informado")}</td>
      <td>${pendencyNameLink(item.paciente || "Não informado", item, true)}</td>
      <td>${pendencyNameLink(item.tutor || "Não informado", item, false)}</td>
      <td><i class="agora-origin ${pendencyOrigin(item) === "Internação" ? "hospital" : "consultation"}">${escapeHTML(pendencyOrigin(item))}</i></td>
      <td class="agora-dashboard-description">${escapeHTML(item.categoria ? item.categoria + ": " : "")}${escapeHTML(item.descricao)}${isOverdue(item) ? '<small class="agora-dashboard-warning">Vencida</small>' : ""}${item.reincidente === true || item.reincidente === "true" ? '<small class="agora-dashboard-warning recurrent">Reincidente</small>' : ""}</td>
      <td><button type="button" class="agora-status-button ${statusClass}" data-open-pending="${escapeHTML(item.id)}" aria-label="${escapeHTML("Editar pendência de " + (item.paciente || "paciente") + ": " + item.status)}">${escapeHTML(item.status)}</button></td>
    </tr>`;
  }

  function openDashboardPending(event) {
    const item = dashboardPendencies.find(pending => String(pending.id) === event.currentTarget.dataset.openPending);
    if (!item) return;
    const overlay = createOverlay("Atualizar pendência", true);
    overlay.dataset.dashboardPending = item.id;
    overlay.querySelector(".agora-modal-body").innerHTML = `<div class="agora-context"><strong>${escapeHTML(item.paciente || "Paciente não informado")} · ${escapeHTML(item.tutor || "Cliente não informado")}</strong><span>${escapeHTML(item.veterinario || "Veterinário não informado")}</span></div>${pendingCard(item)}`;
    document.body.append(overlay);
    overlay.querySelector("[data-update-pending]").addEventListener("click", updateDashboardPending);
    overlay.querySelector("[data-history-pending]").addEventListener("click", showHistory);
  }

  function dashboardPendingPayload(card, id) {
    return {
      id,
      status: card.querySelector("[data-status]").value,
      observacao: card.querySelector("[data-observation]").value.trim(),
      usuario: "Coordenadora"
    };
  }

  function updateDashboardPending(event) {
    const button = event.currentTarget;
    const card = button.closest("[data-pending-id]");
    if (button.disabled) return;
    button.disabled = true;
    runBackgroundSave(() => apiRequest("updatePendencia", { pendencia: dashboardPendingPayload(card, button.dataset.updatePending) }, { blocking: false }))
      .then(() => {
        notify("Pendência atualizada.");
        card.closest(".agora-overlay")?.remove();
        loadDashboardPendencies(true);
      })
      .catch(error => {
        notify(error.message, true);
        button.disabled = false;
      });
  }

  function saveAllDashboardPending(event) {
    const button = event?.currentTarget || document.querySelector("[data-dashboard-save-all]");
    const items = filteredDashboardPendencies();
    if (!items.length) return notify("Não há pendências exibidas para salvar.", true);
    if (button?.disabled) return;
    const editingCard = document.querySelector(".agora-overlay[data-dashboard-pending] [data-pending-id]");
    const payloads = items.map(item => editingCard?.dataset.pendingId === String(item.id) ? dashboardPendingPayload(editingCard, item.id) : { id: item.id, status: item.status, observacao: "", usuario: "Coordenadora" });
    button.disabled = true;
    runBackgroundSave(async () => {
      for (const pendencia of payloads) {
        await apiRequest("updatePendencia", { pendencia }, { blocking: false });
      }
    }).then(() => {
      notify(`Pendências salvas: ${payloads.length}.`);
      loadDashboardPendencies(true);
    }).catch(error => {
      notify(error.message, true);
    }).finally(() => {
      button.disabled = false;
    });
  }

  function openDashboardReport() {
    const items = filteredDashboardPendencies();
    if (!items.length) return notify("Não há pendências nos filtros atuais.", true);
    const text = dashboardReportText(items);
    const overlay = createOverlay("Relatório por veterinário", true);
    overlay.querySelector(".agora-modal-body").innerHTML = `<div class="agora-report-options"><button type="button" class="active" data-report-summary>Resumo atual</button><button type="button" data-report-history>Com histórico</button></div><textarea class="agora-report-text" rows="22" readonly>${escapeHTML(text)}</textarea><div class="agora-actions"><button type="button" data-close>Fechar</button><button type="button" class="agora-primary" data-report-copy>Copiar relatório</button></div>`;
    document.body.append(overlay);
    const textarea = overlay.querySelector(".agora-report-text");
    const summaryButton = overlay.querySelector("[data-report-summary]");
    const historyButton = overlay.querySelector("[data-report-history]");
    let historyText = "";
    let reportMode = "summary";
    summaryButton.addEventListener("click", () => {
      reportMode = "summary";
      textarea.value = text;
      summaryButton.classList.add("active");
      historyButton.classList.remove("active");
    });
    historyButton.addEventListener("click", async () => {
      reportMode = "history";
      summaryButton.classList.remove("active");
      historyButton.classList.add("active");
      if (historyText) {
        textarea.value = historyText;
        return;
      }
      historyButton.disabled = true;
      textarea.value = "Carregando histórico...";
      try {
        const history = await loadDashboardHistory();
        historyText = dashboardHistoryReportText(items, history);
        if (reportMode === "history") textarea.value = historyText;
      } catch (error) {
        if (reportMode === "history") {
          reportMode = "summary";
          textarea.value = text;
          summaryButton.classList.add("active");
          historyButton.classList.remove("active");
        }
        notify(error.message, true);
      } finally {
        historyButton.disabled = false;
      }
    });
    overlay.querySelector("[data-report-copy]").addEventListener("click", () => copyText(textarea.value));
  }

  function dashboardReportText(items) {
    return groupedDashboardReport(items, `PENDÊNCIAS DA COORDENAÇÃO - ${formatDate(todayISO())}`, item => {
      const code = item.codigo ? `[${item.codigo}] ` : "";
      return `  - ${code}${item.descricao} [${item.status}]${item.prazo ? ` - prazo ${formatDate(item.prazo)}` : ""}${isOverdue(item) ? " - VENCIDA" : ""}`;
    });
  }

  function dashboardHistoryReportText(items, history) {
    const byPending = new Map();
    history.forEach(event => {
      if (!byPending.has(event.pendenciaId)) byPending.set(event.pendenciaId, []);
      byPending.get(event.pendenciaId).push(event);
    });
    return groupedDashboardReport(items, `AUDITORIA DE PENDÊNCIAS - ${formatDate(todayISO())}`, item => {
      const lines = [`  - Pendência ${item.codigo || "sem código"}`, `    ${item.descricao} [${item.status}]`];
      const events = (byPending.get(item.id) || []).sort((first, second) => String(first.data).localeCompare(String(second.data)));
      if (!events.length) lines.push("    Histórico: sem eventos registrados");
      else {
        lines.push("    Histórico:");
        events.forEach(event => {
          const transition = event.statusAnterior || event.statusNovo ? ` | ${event.statusAnterior || "-"} → ${event.statusNovo || "-"}` : "";
          lines.push(`    - ${formatDateTime(event.data)} | ${event.usuario || "Não informado"} | ${event.acao || "Evento"}${transition}${event.observacao ? ` | ${event.observacao}` : ""}`);
        });
      }
      return lines.join("\n");
    });
  }

  function groupedDashboardReport(items, title, renderPending) {
    const veterinarians = groupBy(items, item => item.veterinario || "Não informado");
    const sections = [...veterinarians.entries()].sort(([first], [second]) => first.localeCompare(second, "pt-BR")).map(([veterinarian, records]) => {
      const patients = groupBy(records, item => `${item.ciplexAnimalId || item.pacienteId || `${normalizeText(item.paciente)}|${normalizeText(item.tutor)}`}|${formatDate(pendingDate(item))}`);
      const patientSections = [...patients.values()].sort((first, second) => String(first[0].paciente || "").localeCompare(String(second[0].paciente || ""), "pt-BR")).map(patientRecords => {
        const patient = patientRecords[0];
        const identifier = patient.ciplexAnimalId || "sem ID Ciplex";
        const lines = [`- ${patient.paciente || "Paciente não informado"} - ${identifier} - ${patient.tutor || "Tutor não informado"} - Abertura: ${pendingDate(patient) ? formatDate(pendingDate(patient)) : "não informada"}:`];
        const origins = groupBy(patientRecords, pendencyOrigin);
        ["Internação", "Consulta"].forEach(origin => {
          const pending = origins.get(origin);
          if (!pending?.length) return;
          lines.push(` ${origin}:`);
          pending.forEach(item => lines.push(renderPending(item)));
        });
        [...origins.entries()].filter(([origin]) => !["Internação", "Consulta"].includes(origin)).forEach(([origin, pending]) => {
          lines.push(` ${origin}:`);
          pending.forEach(item => lines.push(renderPending(item)));
        });
        return lines.join("\n");
      });
      return [`VETERINÁRIO: ${veterinarian}`, ...patientSections].join("\n\n");
    });
    return [title, ...sections].join("\n\n");
  }

  function groupBy(items, key) {
    const groups = new Map();
    items.forEach(item => {
      const value = key(item);
      if (!groups.has(value)) groups.set(value, []);
      groups.get(value).push(item);
    });
    return groups;
  }

  function pendencyOrigin(item) {
    if (item.origem === "Internação") return "Internação";
    if (item.origem === "Consulta" || item.origem === "Ciplex") return "Consulta";
    return item.origem || "Origem não informada";
  }

  function copyText(text) {
    try { GM_setClipboard(text, "text"); } catch { navigator.clipboard.writeText(text); }
    notify("Texto copiado.");
  }

  async function exportOperationalData(format) {
    try {
      const result = await apiRequest("export", { type: "pendencias", format });
      const exported = result.exportacao;
      const prefix = format === "csv" ? "\uFEFF" : "";
      downloadBlob(new Blob([prefix, exported.content], { type: `${exported.mimeType};charset=utf-8` }), exported.filename);
      notify(`Exportação ${format.toUpperCase()} concluída.`);
    } catch (error) {
      notify(error.message, true);
    }
  }



  function openConsultationControl() {
    if (document.querySelector("#agora-consultations-root")) return;
    beginPanelHistory("consultations");
    const today = todayISO();
    const root = document.createElement("section");
    root.id = "agora-consultations-root";
    root.innerHTML = `<main class="agora-consultation-page">
      <header><div><h1>Avaliação de consultas</h1><p>Completude, suficiência, coerência e documentação integradas às pendências operacionais.</p></div><div class="agora-panel-navigation"><button type="button" data-consultation-dashboard>Painel da coordenação</button><button type="button" data-consultation-close>Fechar</button></div></header>
      <div class="agora-consultation-toolbar">
        <label>Data inicial<input type="date" data-consultation-start value="${today}"></label>
        <label>Data final<input type="date" data-consultation-end value="${today}"></label>
        <button type="button" class="agora-primary" data-consultation-fetch>Buscar no Ciplex</button>
        <select data-consultation-veterinarian><option value="">Selecione o veterinário</option></select>
        <button type="button" data-consultation-copy>Copiar por veterinário</button>
        <button type="button" data-consultation-export>Exportar XLS</button>
      </div>
      <div class="agora-consultation-table"><table><thead><tr><th>Cliente</th><th>Animal</th><th>Data</th><th>Médico Veterinário</th><th>Avaliação</th></tr></thead><tbody></tbody></table></div>
    </main>`;
    document.body.append(root);
    root.querySelector("[data-consultation-dashboard]").addEventListener("click", () => switchCoordinationPanel(openCoordinationDashboard));
    root.querySelector("[data-consultation-close]").addEventListener("click", () => closeCoordinationPanel(true));
    const fetchButton = root.querySelector("[data-consultation-fetch]");
    fetchButton.addEventListener("click", fetchConsultations);
    root.querySelector("[data-consultation-copy]").addEventListener("click", copyVeterinarianReport);
    root.querySelector("[data-consultation-export]").addEventListener("click", exportConsultationsXls);
    renderConsultations();
    fetchConsultations({ currentTarget: fetchButton });
  }

  async function fetchConsultations(event) {
    const root = document.querySelector("#agora-consultations-root");
    const start = root.querySelector("[data-consultation-start]").value;
    const end = root.querySelector("[data-consultation-end]").value;
    if (!start || !end) return notify("Informe as datas inicial e final.", true);
    if (start > end) return notify("A data inicial não pode ser posterior à data final.", true);
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "Buscando...";
    try {
      const period = `${isoToBrazilian(start)} - ${isoToBrazilian(end)}`;
      const endpoint = `/sistema/relatorios_atendimento/exibir_atendimentos_realizados?${new URLSearchParams({ "data[periodo]": period })}`;
      const text = await withLoading("Buscando consultas no Ciplex...", async () => {
        const response = await fetch(endpoint, { credentials: "include", headers: { "X-Requested-With": "XMLHttpRequest" } });
        if (!response.ok) throw new Error(`O Ciplex respondeu com o código ${response.status}.`);
        return response.text();
      });
      if (/login|entrar no sistema/i.test(text) && !/<table/i.test(text)) throw new Error("A sessão do Ciplex parece ter expirado.");
      consultationRecords = extractConsultations(text);
      rememberConsultationLinks(consultationRecords);
      renderConsultations();
      notify(`${consultationRecords.length} consulta${consultationRecords.length === 1 ? "" : "s"} carregada${consultationRecords.length === 1 ? "" : "s"}.`);
    } catch (error) {
      notify(error.message, true);
    } finally {
      button.disabled = false;
      button.textContent = "Buscar no Ciplex";
    }
  }

  function extractConsultations(html) {
    const documentCopy = new DOMParser().parseFromString(html, "text/html");
    const table = [...documentCopy.querySelectorAll("table")].find(element => {
      const headers = [...element.querySelectorAll("thead th")].map(item => normalizeText(item.textContent));
      return headers.includes("item") && headers.includes("animal");
    });
    if (!table) throw new Error("A tabela de atendimentos não foi encontrada na resposta do Ciplex.");
    return [...table.querySelectorAll("tbody tr")].map(row => {
      const cells = row.querySelectorAll("td");
      if (cells.length < 5) return null;
      const item = normalizeText(cells[3].textContent);
      if (!item.includes("consulta") && !item.includes("retorno")) return null;
      const clientLink = cells[1].querySelector("a");
      const animalLink = cells[2].querySelector("a");
      const clientUrl = clientLink?.getAttribute("href") || "";
      const animalUrl = animalLink?.getAttribute("href") || "";
      const ids = extractCiplexIds(`${clientUrl} ${animalUrl}`);
      return {
        id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
        cliente: clientLink?.textContent.trim() || cells[1].textContent.trim(),
        animal: animalLink?.textContent.trim() || cells[2].textContent.trim(),
        data: cells[0].textContent.trim(),
        veterinario: cells[4].textContent.trim(),
        clienteId: ids.clienteId,
        pacienteId: ids.pacienteId,
        clienteUrl: safeCiplexUrl(clientUrl),
        animalUrl: safeCiplexUrl(animalUrl),
        avaliado: false,
        observacoesGerais: "",
        criterios: Object.fromEntries(CONSULTATION_CRITERIA.map(criterion => [criterion.key, { adequado: true, comentario: "" }]))
      };
    }).filter(Boolean);
  }

  function renderConsultations() {
    const root = document.querySelector("#agora-consultations-root");
    if (!root) return;
    const body = root.querySelector("tbody");
    body.innerHTML = consultationRecords.length ? consultationRecords.map(item => {
      const pendingCount = CONSULTATION_CRITERIA.filter(criterion => !item.criterios[criterion.key].adequado).length;
      const status = !item.avaliado ? "Pendente de avaliação" : pendingCount ? `${pendingCount} critério${pendingCount === 1 ? "" : "s"} com pendência` : "Sem pendências";
      return `<tr data-consultation-id="${escapeHTML(item.id)}"><td>${consultationName(item.cliente, item.clienteUrl)}</td><td>${consultationName(item.animal, item.animalUrl)}</td><td>${escapeHTML(item.data)}</td><td>${escapeHTML(item.veterinario)}</td><td><span class="agora-consultation-status ${item.avaliado ? pendingCount ? "error" : "ok" : ""}">${escapeHTML(status)}</span><button type="button" class="agora-primary" data-consultation-review>${item.avaliado ? "Editar avaliação" : "Avaliar consulta"}</button></td></tr>`;
    }).join("") : `<tr><td colspan="5" class="agora-consultation-empty">Escolha o período e busque os atendimentos realizados.</td></tr>`;
    body.querySelectorAll("[data-consultation-review]").forEach(button => button.addEventListener("click", openConsultationReview));
    updateConsultationVeterinarians();
  }

  function consultationName(name, url) {
    return `<div class="agora-consultation-name">${url ? `<a href="${escapeHTML(url)}" target="_blank" rel="noopener"><span class="agora-link-icon" aria-hidden="true">🔗</span> ${escapeHTML(name)}</a>` : `<span>${escapeHTML(name)}</span>`}</div>`;
  }

  function openConsultationReview(event) {
    const id = event.currentTarget.closest("tr").dataset.consultationId;
    const record = consultationRecords.find(item => item.id === id);
    if (!record) return;
    const overlay = createOverlay("Avaliação da consulta", true);
    overlay.dataset.consultationId = id;
    overlay.querySelector(".agora-modal-body").innerHTML = `
      <div class="agora-context"><strong>${escapeHTML(record.animal)} · ${escapeHTML(record.cliente)}</strong><span>${escapeHTML(record.data)} · ${escapeHTML(record.veterinario)}</span></div>
      <form data-consultation-review-form>${CONSULTATION_CRITERIA.map(criterion => {
        const value = record.criterios[criterion.key];
        return `<section class="agora-criterion"><header><b>${escapeHTML(criterion.label)}</b><label><input type="checkbox" data-criterion-adequate="${criterion.key}" ${value.adequado ? "checked" : ""}> Adequado</label></header><textarea rows="3" data-criterion-comment="${criterion.key}" placeholder="Descreva a pendência quando o critério for inadequado.">${escapeHTML(value.comentario)}</textarea></section>`;
      }).join("")}<label>Observações gerais<textarea rows="3" data-consultation-general>${escapeHTML(record.observacoesGerais)}</textarea></label><div class="agora-actions"><button type="button" data-close>Cancelar</button><button type="submit" class="agora-primary">Salvar avaliação</button></div></form>`;
    document.body.append(overlay);
    overlay.querySelector("form").addEventListener("submit", saveConsultationReview);
  }

  function saveConsultationReview(event) {
    event.preventDefault();
    const overlay = event.currentTarget.closest(".agora-overlay");
    const record = consultationRecords.find(item => item.id === overlay.dataset.consultationId);
    const submit = event.submitter;
    let invalid;
    const changes = CONSULTATION_CRITERIA.map(criterion => {
      const adequate = overlay.querySelector(`[data-criterion-adequate="${criterion.key}"]`).checked;
      const comment = overlay.querySelector(`[data-criterion-comment="${criterion.key}"]`).value.trim();
      return { criterion, adequate, comment };
    });
    changes.forEach(({ adequate, comment, criterion }) => {
      const field = overlay.querySelector(`[data-criterion-comment="${criterion.key}"]`);
      field.classList.toggle("agora-invalid", !adequate && !comment);
      if (!adequate && !comment) invalid ||= field;
    });
    if (invalid) {
      invalid.focus();
      return notify("Descreva cada critério marcado como inadequado.", true);
    }
    const general = overlay.querySelector("[data-consultation-general]").value.trim();
    submit.disabled = true;
    submit.textContent = "Salvando...";
    changes.forEach(({ criterion, adequate, comment }) => {
      record.criterios[criterion.key] = { adequado: adequate, comentario: comment };
    });
    record.observacoesGerais = general;
    record.avaliado = true;
    overlay.remove();
    renderConsultations();
    notify("Avaliação enviada para salvamento.");
    runBackgroundSave(async () => {
      const pendingResult = await apiRequest("listPendencias", {}, { blocking: false });
      for (const { criterion, adequate, comment } of changes) {
        const originId = consultationOriginId(record, criterion.key);
        const existing = pendingResult.pendencias.find(item => item.origemRegistro === originId);
        if (!adequate) {
          const pending = {
            id: existing?.id,
            origemRegistro: originId,
            ciplexAnimalId: record.pacienteId,
            ciplexClienteId: record.clienteId,
            clienteId: record.clienteId,
            clienteUrl: record.clienteUrl,
            animalUrl: record.animalUrl,
            paciente: record.animal,
            tutor: record.cliente,
            veterinario: record.veterinario,
            categoria: criterion.category,
            origem: "Consulta",
            descricao: `${criterion.label}: ${comment}`,
            status: existing?.status === "Encerrada" ? "Aberta" : existing?.status || "Aberta",
            observacoes: general,
            observacao: existing ? "Critério de consulta reavaliado." : "Pendência criada pela avaliação de consulta.",
            usuario: "Coordenadora"
          };
          await apiRequest(existing ? "updatePendencia" : "createPendencia", { pendencia: pending }, { blocking: false });
        } else if (existing && !["Resolvida", "Encerrada"].includes(existing.status)) {
          await apiRequest("updatePendencia", { pendencia: { id: existing.id, status: "Resolvida", observacao: "Critério reavaliado como adequado.", usuario: "Coordenadora" } }, { blocking: false });
        }
      }
    }).then(() => notify("Avaliação salva e pendências sincronizadas."))
      .catch(error => notify(error.message, true));
  }

  function consultationOriginId(record, criterion) {
    const patient = record.pacienteId || normalizeText(record.animal);
    return `consulta:${patient}:${record.data}:${normalizeText(record.veterinario)}:${criterion}`;
  }

  function updateConsultationVeterinarians() {
    const select = document.querySelector("[data-consultation-veterinarian]");
    if (!select) return;
    const previous = select.value;
    const names = [...new Set(consultationRecords.map(item => item.veterinario.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR"));
    select.innerHTML = `<option value="">Selecione o veterinário</option>${names.map(name => `<option>${escapeHTML(name)}</option>`).join("")}`;
    if (names.includes(previous)) select.value = previous;
  }

  function copyVeterinarianReport() {
    const name = document.querySelector("[data-consultation-veterinarian]")?.value;
    if (!name) return notify("Selecione um médico veterinário.", true);
    const items = consultationRecords.filter(item => normalizeText(item.veterinario) === normalizeText(name));
    if (!items.length) return notify("Não há consultas para esse veterinário.", true);
    const text = items.map(consultationReportText).join("\n\n");
    try { GM_setClipboard(text, "text"); } catch { navigator.clipboard.writeText(text); }
    notify("Relatório por veterinário copiado.");
  }

  function consultationReportText(item) {
    const lines = [`${item.animal} - ${item.cliente} - Consulta em ${item.data}`, "Avaliação:"];
    CONSULTATION_CRITERIA.forEach(criterion => {
      const value = item.criterios[criterion.key];
      lines.push(`${criterion.label}: ${!item.avaliado ? "Não avaliado" : value.adequado ? value.comentario ? `Adequado - ${value.comentario}` : "Sem pendências" : `Pendência - ${value.comentario}`}`);
    });
    if (item.observacoesGerais) lines.push(`Observações gerais: ${item.observacoesGerais}`);
    return lines.join("\n");
  }

  function exportConsultationsXls() {
    if (!consultationRecords.length) return notify("Não há consultas para exportar.", true);
    const rows = consultationRecords.map(item => `<tr><td>${escapeHTML(item.clienteId)}</td><td>${escapeHTML(item.pacienteId)}</td><td>${escapeHTML(item.cliente)}</td><td>${escapeHTML(item.animal)}</td><td>${escapeHTML(item.data)}</td><td>${escapeHTML(item.veterinario)}</td>${CONSULTATION_CRITERIA.map(criterion => `<td>${escapeHTML(criterionValue(item, criterion.key))}</td>`).join("")}<td>${escapeHTML(item.observacoesGerais)}</td></tr>`).join("");
    const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><table><thead><tr><th>ID do cliente</th><th>ID do paciente</th><th>Cliente</th><th>Animal</th><th>Data</th><th>Médico Veterinário</th>${CONSULTATION_CRITERIA.map(item => `<th>${item.label}</th>`).join("")}<th>Observações gerais</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
    downloadBlob(new Blob(["\uFEFF", html], { type: "application/vnd.ms-excel;charset=utf-8" }), `pendencias de consultas ${todayISO()}.xls`);
    notify("Planilha de consultas exportada.");
  }

  function criterionValue(item, key) {
    if (!item.avaliado) return "Não avaliado";
    const value = item.criterios[key];
    return value.adequado ? value.comentario ? `Adequado - ${value.comentario}` : "Sem pendências" : `Pendência - ${value.comentario}`;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function extractCiplexIds(value) {
    const text = String(value || "");
    const client = text.match(/clientes\/exibir\/(\d+)/i) || text.match(/[?&#]Cliente(?:\.id)?=(\d+)/i);
    const patient = text.match(/[?&#]Animal\.editar=(\d+)/i) || text.match(/[?&#](?:Animal|Paciente)(?:\.id)?=(\d+)/i);
    return { clienteId: client?.[1] || "", pacienteId: patient?.[1] || "" };
  }

  function safeCiplexUrl(value) {
    if (!value) return "";
    try {
      const url = new URL(value, "https://ciplexsistemas.com");
      return url.origin === "https://ciplexsistemas.com" ? url.href : "";
    } catch { return ""; }
  }

  function normalizeText(value) {
    return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLocaleLowerCase("pt-BR");
  }

  function isoToBrazilian(value) {
    const [year, month, day] = value.split("-");
    return `${day}/${month}/${year}`;
  }

  function injectStyles() {
    if (document.querySelector("#agora-coordination-styles")) return;
    const style = document.createElement("style");
    style.id = "agora-coordination-styles";
    style.textContent = `
      .agora-overlay{position:fixed;inset:0;z-index:2147483646;background:#092a2488;display:grid;place-items:center;padding:20px;font-family:Arial,sans-serif}.agora-primary{background:#0b594a!important;color:#fff!important;border-color:#0b594a!important}.agora-modal{width:min(560px,96vw);max-height:92vh;overflow:auto;background:#f7f4ec;border-radius:12px;box-shadow:0 24px 80px #001d18aa;color:#17342e}.agora-modal.wide{width:min(980px,96vw)}.agora-modal>header{position:sticky;top:0;z-index:1;display:flex;align-items:center;justify-content:space-between;padding:18px 22px;background:#052d25;color:#fff}.agora-modal h2{margin:0;font:700 20px Arial}.agora-modal>header button{border:0;background:transparent;color:#fff;font-size:28px;cursor:pointer}.agora-modal-body{padding:22px}.agora-modal label{display:grid;gap:6px;margin-bottom:14px;font-size:12px;font-weight:700;text-transform:uppercase}.agora-modal input,.agora-modal select,.agora-modal textarea{width:100%;box-sizing:border-box;border:1px solid #9ca9a4;border-radius:6px;background:#fff;padding:9px;color:#172b27;font:14px Arial;text-transform:none}.agora-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.agora-actions{display:flex;justify-content:flex-end;gap:9px;margin-top:14px}.agora-actions button{border:1px solid #527068;border-radius:6px;background:#fff;padding:9px 14px;cursor:pointer}.agora-actions .agora-primary{background:#0b594a;color:#fff;border-color:#0b594a}.agora-context{display:flex;justify-content:space-between;gap:12px;margin-bottom:18px;padding:12px;background:#e4ebe7}.agora-context span{color:#52645f}.agora-indicators{display:flex;gap:10px;margin-bottom:18px}.agora-indicators span{min-width:100px;padding:12px;background:#e3eae6;border-radius:8px}.agora-indicators b{display:block;font-size:24px}.agora-indicators .danger{background:#f4d8d3;color:#8b2719}.agora-pending-list{display:grid;gap:12px}.agora-pending-card{padding:16px;border:1px solid #bac7c2;border-left:5px solid #4e756a;border-radius:8px;background:#fff}.agora-pending-card.overdue{border-left-color:#b3392b}.agora-pending-card header{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.agora-pending-card header span{font-weight:700}.agora-pending-card header b{margin-left:auto}.agora-pending-card header em,.agora-origin,.agora-pending-card header code{padding:3px 7px;border-radius:999px;font:700 11px Arial;font-style:normal}.agora-pending-card header em{background:#fff0c2}.agora-origin.hospital{background:#dbe9f5;color:#245a83}.agora-origin.consultation{background:#dcefe5;color:#176345}.agora-pending-card header code{background:#ece9e0;color:#46534f}.agora-pending-card p{margin:10px 0}.agora-pending-card small{color:#60706c}.agora-latest-observation{margin:12px 0;padding:10px 12px;border-left:3px solid #d8892f;background:#faf3e7}.agora-latest-observation>b{font-size:12px;text-transform:uppercase}.agora-latest-observation p{margin:5px 0}.agora-history{margin-top:14px;padding:10px;background:#edf1ef}.agora-history div+div{border-top:1px solid #ccd5d1;margin-top:8px;padding-top:8px}.agora-history p{margin:4px 0 0}.agora-notice{position:fixed;right:18px;bottom:18px;z-index:2147483647;max-width:360px;padding:12px 16px;border-radius:7px;background:#0b594a;color:#fff;font:14px Arial;box-shadow:0 5px 24px #0005}#agora-saving-indicator{position:fixed;right:18px;bottom:70px;z-index:2147483647;display:none;align-items:center;gap:8px;padding:10px 13px;border-radius:7px;background:#052d25;color:#fff;font:700 13px Arial;box-shadow:0 5px 24px #0005}#agora-saving-indicator.visible{display:flex}#agora-saving-indicator span{width:14px;height:14px;border:2px solid #ffffff55;border-top-color:#fff;border-radius:50%;animation:agora-saving-spin .8s linear infinite}@keyframes agora-saving-spin{to{transform:rotate(360deg)}}.agora-notice.error{background:#8b2719}.agora-invalid{border-color:#b3392b!important;box-shadow:0 0 0 2px #b3392b22}.agora-criterion{padding:14px;margin-bottom:12px;border:1px solid #c8d2ce;border-radius:8px;background:#fff}.agora-criterion header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}.agora-criterion header label{display:flex;align-items:center;gap:6px;margin:0}.agora-criterion header input{width:auto}.agora-consultation-launcher{position:fixed;right:20px;bottom:20px;z-index:2147483000;border:0;border-radius:9px;padding:12px 16px;background:#0b4a3f;color:#fff;font:700 14px Arial;cursor:pointer;box-shadow:0 5px 18px #0003}#agora-consultations-root{position:fixed;inset:0;z-index:2147483500;overflow:auto;background:#f7f5f1;color:#25312e;font-family:Arial,sans-serif}#agora-consultations-root *{box-sizing:border-box}.agora-consultation-page{max-width:1600px;margin:auto;padding:24px}.agora-consultation-page>header{display:flex;justify-content:space-between;gap:20px}.agora-consultation-page h1{margin:0;color:#0b4a3f}.agora-consultation-page p{margin:5px 0;color:#65736f}.agora-consultation-page button{border:0;border-radius:7px;padding:9px 12px;font-weight:700;cursor:pointer}.agora-consultation-toolbar{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap;margin:18px 0}.agora-consultation-toolbar label{display:flex;flex-direction:column;gap:5px;min-width:140px;font-size:12px;font-weight:700;line-height:1.2}.agora-consultation-toolbar input,.agora-consultation-toolbar select{height:38px;border:1px solid #bdc8c4;border-radius:6px;padding:8px;background:#fff;line-height:1.2}.agora-consultation-toolbar [data-consultation-start],.agora-consultation-toolbar [data-consultation-end]{width:140px}.agora-consultation-toolbar [data-consultation-veterinarian]{width:280px;min-width:280px}.agora-consultation-toolbar>button{height:38px;white-space:nowrap}.agora-consultation-table{overflow:auto;border:1px solid #ccd4d1;border-radius:8px;background:#fff}.agora-consultation-table table{width:100%;min-width:1050px;border-collapse:collapse}.agora-consultation-table th{padding:10px;background:#0b4a3f;color:#fff;text-align:left}.agora-consultation-table td{padding:9px;border-bottom:1px solid #dbe1de}.agora-consultation-table td:last-child{display:flex;justify-content:space-between;align-items:center;gap:10px}.agora-consultation-name{display:flex;justify-content:space-between;gap:8px}.agora-consultation-name a{color:#0b594a;font-weight:700}.agora-consultation-status{padding:4px 8px;border-radius:999px;background:#fff1cf;color:#795600;font-size:11px;font-weight:700}.agora-consultation-status.ok{background:#dcefe9;color:#0b4a3f}.agora-consultation-status.error{background:#f4e5e3;color:#9d3028}.agora-consultation-empty{padding:35px!important;text-align:center;color:#687671}@media(max-width:650px){.agora-grid{grid-template-columns:1fr}.agora-indicators{flex-wrap:wrap}}
    `;
    style.textContent += `
      .agora-dashboard-launcher{position:fixed;right:20px;bottom:72px;z-index:2147483000;border:0;border-radius:9px;padding:12px 16px;background:#d8892f;color:#fff;font:700 14px Arial;cursor:pointer;box-shadow:0 5px 18px #0003}
      #agora-dashboard-root{position:fixed;inset:0;z-index:2147483550;overflow:auto;background:#f2f0e9;color:#21352f;font-family:Arial,sans-serif}
      #agora-dashboard-root *{box-sizing:border-box}.agora-dashboard-page{max-width:1450px;margin:auto;padding:24px}.agora-dashboard-page>header{display:flex;justify-content:space-between;gap:20px;margin-bottom:18px}.agora-dashboard-page h1{margin:0;color:#0b4a3f}.agora-dashboard-page p{margin:5px 0;color:#66736f}.agora-dashboard-page button{border:1px solid #9baba5;border-radius:7px;padding:9px 12px;background:#fff;font-weight:700;cursor:pointer}
      .agora-dashboard-filters{display:grid;grid-template-columns:2fr repeat(5,1fr);gap:9px;padding:14px;background:#fff;border:1px solid #d1d9d5;border-radius:9px}.agora-dashboard-filters label{display:grid;gap:5px;font-size:11px;font-weight:700;text-transform:uppercase}.agora-dashboard-filters input,.agora-dashboard-filters select{min-width:0;width:100%;border:1px solid #bac7c2;border-radius:6px;padding:8px;background:#fff}
      .agora-dashboard-actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;margin:12px 0}.agora-dashboard-list{display:block}.agora-dashboard-list .agora-pending-card{min-width:0}.agora-report-options{display:flex;gap:8px;margin-bottom:12px}.agora-report-options button{border:1px solid #8fa39c;border-radius:999px;padding:8px 14px;background:#fff;color:#27453d;font-weight:700;cursor:pointer}.agora-report-options button.active{background:#0b594a;color:#fff;border-color:#0b594a}.agora-report-text{width:100%;box-sizing:border-box;border:1px solid #bac7c2;border-radius:7px;padding:12px;background:#fff;color:#20352f;font:13px/1.45 Consolas,monospace;resize:vertical}
      @media(max-width:1050px){.agora-dashboard-filters{grid-template-columns:repeat(3,1fr)}.agora-dashboard-filters label:first-child{grid-column:span 3}}
      @media(max-width:650px){.agora-dashboard-filters{grid-template-columns:1fr}.agora-dashboard-filters label:first-child{grid-column:auto}.agora-dashboard-list{grid-template-columns:1fr}.agora-dashboard-page{padding:12px}}
    `;
    style.textContent += `
      #agora-loading-overlay{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:24px;background:#052d25d9;color:#fff;opacity:0;visibility:hidden;pointer-events:none;transition:opacity .16s ease,visibility .16s ease;font-family:Arial,sans-serif}
      #agora-loading-overlay.visible{opacity:1;visibility:visible;pointer-events:all}#agora-loading-overlay>div{min-width:min(340px,calc(100vw - 48px));padding:30px 28px;border:1px solid #c0f6ff88;border-radius:9px;background:#052d25;box-shadow:0 18px 60px #0006;text-align:center}
      #agora-loading-overlay i{display:block;width:54px;height:54px;margin:0 auto 18px;border:5px solid #c0f6ff3d;border-top-color:#c0f6ff;border-radius:50%;animation:agora-loading-spin .75s linear infinite}#agora-loading-overlay strong,#agora-loading-overlay small{display:block}#agora-loading-overlay strong{font-size:18px}#agora-loading-overlay small{margin-top:7px;color:#c0f6ff;font-size:12px}
      @keyframes agora-loading-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){#agora-loading-overlay{transition:none}#agora-loading-overlay i{animation-duration:1.5s}}
    `;
    style.textContent += "\n      .agora-dashboard-table{overflow:auto;border:1px solid #ccd4d1;border-radius:8px;background:#fff}.agora-dashboard-table table{width:100%;min-width:1050px;border-collapse:collapse}.agora-dashboard-table th{padding:10px;background:#0b4a3f;color:#fff;text-align:left}.agora-dashboard-table td{padding:9px;border-bottom:1px solid #dbe1de;vertical-align:top}.agora-dashboard-table th button{border:0;background:transparent;color:inherit;padding:0;text-align:left;font:inherit;font-weight:700;white-space:nowrap}.agora-dashboard-table th button:focus-visible{outline:2px solid #c0f6ff;outline-offset:4px}.agora-dashboard-description{min-width:240px;white-space:pre-wrap;overflow-wrap:anywhere}.agora-dashboard-overdue td{background:#fff7f5}.agora-dashboard-overdue td:first-child{box-shadow:inset 4px 0 #b3392b}.agora-dashboard-warning{display:block;margin-top:4px;color:#9d3028;font-size:11px;font-weight:700}.agora-dashboard-warning.recurrent{color:#795600}.agora-dashboard-table .agora-status-button{border:0;border-radius:999px;padding:6px 10px;font-size:11px;white-space:nowrap}.agora-status-button.open{background:#fff1cf;color:#795600}.agora-status-button.communicated{background:#dbe9f5;color:#245a83}.agora-status-button.regularizing{background:#eee1f5;color:#6b3886}.agora-status-button.resolved{background:#dcefe9;color:#0b4a3f}.agora-status-button.closed{background:#e7e9e8;color:#52615b}\n";
    style.textContent += ".agora-modal select{height:auto;min-height:40px;line-height:1.4;padding:9px 30px 9px 9px}.agora-panel-navigation{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.agora-dashboard-table .agora-consultation-name a{color:#0b594a;font-weight:700}";
    style.textContent += "#agora-consultations-root{background:#f2f0e9;color:#21352f}.agora-consultation-page{max-width:1450px}.agora-consultation-page>header{margin-bottom:18px}.agora-consultation-page button{border:1px solid #9baba5;border-radius:7px;padding:9px 12px;background:#fff;color:#21352f;font-weight:700}.agora-consultation-toolbar{gap:9px;padding:14px;margin:12px 0 18px;background:#fff;border:1px solid #d1d9d5;border-radius:9px}.agora-consultation-toolbar label{font-size:11px;text-transform:uppercase}.agora-consultation-toolbar input,.agora-consultation-toolbar select{border-color:#bac7c2}.agora-consultation-page button.agora-primary{background:#0b594a;color:#fff;border-color:#0b594a}@media(max-width:650px){.agora-consultation-page{padding:12px}.agora-consultation-toolbar [data-consultation-veterinarian]{min-width:0;max-width:100%}}";
    style.textContent += ".agora-consultation-name a,.agora-dashboard-table .agora-consultation-name a{color:#0b594a;font-weight:700;text-decoration:underline;text-underline-offset:2px}.agora-link-icon{font-size:11px}.agora-consultation-name a:hover{color:#052d25;text-decoration-thickness:2px}";
    document.head.append(style);
  }
})();
