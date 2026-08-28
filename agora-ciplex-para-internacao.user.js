// ==UserScript==
// @name         Ágora - Ciplex para Internação
// @namespace    https://agoraveterinaria.com.br/
// @version      1.1.0
// @description  Abre ou cria a ficha de internação a partir do paciente aberto no Ciplex.
// @author       Ágora Clínica Veterinária
// @match        https://ciplexsistemas.com/sistema/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @updateURL    https://raw.githubusercontent.com/gcgvet/agora-hv-coordenacao-tampermonkey/main/agora-ciplex-para-internacao.user.js
// @downloadURL  https://raw.githubusercontent.com/gcgvet/agora-hv-coordenacao-tampermonkey/main/agora-ciplex-para-internacao.user.js
// ==/UserScript==

(function () {
  "use strict";

  const WEB_APP_URL = "https://script.google.com/macros/s/AKfycbyYjJIoUHUspHeZCUoZb_tnupYF6_cI3qeQGxSGAtjR7F5EaHmbGpIiezPwbzzqR-jcow/exec";
  const SITE_URL_KEY = "agora-hospital-site-url";
  const BUTTON_CLASS = "agora-enviar-internacao";
  const inFlightAnimalIds = new Set();
  let injectionTimer;

  if (typeof GM_registerMenuCommand === "function") {
    GM_registerMenuCommand("Configurar caminho da ficha de internação", configureSiteUrl);
  }

  function scopedElement(scope, id) {
    const matches = [...scope.querySelectorAll(`[id="${id}"]`)];
    return matches.find(element => element.offsetParent !== null) || matches.at(-1) || null;
  }

  function value(scope, id) {
    return scopedElement(scope, id)?.value?.trim() || "";
  }

  function selectedText(scope, id) {
    const select = scopedElement(scope, id);
    return select?.selectedOptions?.[0]?.textContent?.trim() || "";
  }

  function calculateAge(birthDate) {
    const match = birthDate.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!match) return "";
    const birth = new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]));
    const today = new Date();
    if (Number.isNaN(birth.getTime()) || birth > today) return "";

    let years = today.getFullYear() - birth.getFullYear();
    let months = today.getMonth() - birth.getMonth();
    if (today.getDate() < birth.getDate()) months -= 1;
    if (months < 0) {
      years -= 1;
      months += 12;
    }
    if (years <= 0) return `${Math.max(months, 0)} meses`;
    return months ? `${years} anos e ${months} meses` : `${years} anos`;
  }

  function brazilianDateValue(text) {
    const match = text.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (!match) return 0;
    return new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1])).getTime();
  }

  function latestWeight(animalRoot, animalId) {
    const panel = animalRoot.querySelector(`[id="pesagens-animal-${animalId}"]`);
    if (!panel) return "";
    const entries = [...panel.querySelectorAll("table tbody tr")]
      .map(row => {
        const cells = row.querySelectorAll("td");
        return cells.length >= 3 ? {
          date: brazilianDateValue(cells[1].textContent.trim()),
          weight: cells[2].textContent.trim()
        } : null;
      })
      .filter(entry => entry?.weight);
    entries.sort((first, second) => second.date - first.date);
    return entries[0]?.weight || "";
  }

  function clientScope(animalRoot) {
    let scope = animalRoot.parentElement;
    while (scope && scope !== document.body) {
      if (scope.querySelector('[id="PessoaNome"]')) return scope;
      scope = scope.parentElement;
    }
    return document;
  }

  function tutorPhone(scope) {
    const ddd = value(scope, "PessoaFone0Ddd").replace(/\D/g, "");
    const number = value(scope, "PessoaFone0Numero");
    if (ddd && number) return `(${ddd}) ${number}`;
    return number;
  }

  function extractPatient(animalRoot) {
    const ciplexAnimalId = value(animalRoot, "AnimalIdAnimal");
    const tutorArea = clientScope(animalRoot);
    const age = value(animalRoot, "AnimalIdade")
      || calculateAge(value(animalRoot, "AnimalDtNascimento"));
    const neuteredValue = value(animalRoot, "AnimalCastrado");

    return {
      ciplexAnimalId,
      recordNumber: ciplexAnimalId,
      weight: latestWeight(animalRoot, ciplexAnimalId),
      name: value(animalRoot, "AnimalNome"),
      species: selectedText(animalRoot, "AnimalIdEspecie"),
      breed: selectedText(animalRoot, "AnimalIdRaca"),
      sex: selectedText(animalRoot, "AnimalSexo"),
      age,
      neutered: neuteredValue === "1" || selectedText(animalRoot, "AnimalCastrado").toLowerCase() === "sim",
      tutor: value(tutorArea, "PessoaNome"),
      contact: tutorPhone(tutorArea)
    };
  }

  function sendPatient(patient) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "POST",
        url: WEB_APP_URL,
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        data: JSON.stringify({ action: "importInternacaoCiplex", internacao: patient }),
        timeout: 60000,
        onload(response) {
          let result;
          try {
            result = JSON.parse(response.responseText);
          } catch {
            reject(new Error("O Apps Script retornou uma resposta inválida."));
            return;
          }
          if (response.status < 200 || response.status >= 300 || !result.ok) {
            reject(new Error(result.error || "Não foi possível enviar o paciente."));
            return;
          }
          if (typeof result.created !== "boolean" || !result.internacao?.id) {
            reject(new Error("O Apps Script retornou uma internação inválida."));
            return;
          }
          resolve(result);
        },
        ontimeout() {
          reject(new Error("O Apps Script não respondeu a tempo."));
        },
        onerror() {
          reject(new Error("Não foi possível acessar o Apps Script."));
        }
      });
    });
  }

  function normalizeSiteUrl(input) {
    let text = String(input || "").trim().replace(/^["']|["']$/g, "");
    if (/^[a-z]:[\\/]/i.test(text)) text = `file:///${text.replace(/\\/g, "/")}`;
    else if (/^\\\\[^\\]+\\[^\\]+/.test(text)) text = `file:${text.replace(/\\/g, "/")}`;
    let url;
    try {
      url = new URL(text);
    } catch {
      throw new Error("Informe o caminho completo até site\\index.html.");
    }
    if (url.protocol !== "file:") throw new Error("A ficha deve ser aberta por uma URL file:///.");
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      pathname = url.pathname;
    }
    if (!/\/site\/index\.html$/i.test(pathname.replace(/\\/g, "/"))) {
      throw new Error("O caminho deve terminar em site\\index.html.");
    }
    url.search = "";
    url.hash = "";
    return url.href;
  }

  function configureSiteUrl() {
    const current = GM_getValue(SITE_URL_KEY, "");
    const input = window.prompt(
      "Informe o caminho completo da ficha nesta estação.\nExemplo: J:\\Meu Drive\\Tratamento Hospitalar\\site\\index.html",
      current
    );
    if (input === null) return "";
    try {
      const normalized = normalizeSiteUrl(input);
      GM_setValue(SITE_URL_KEY, normalized);
      window.alert("Caminho da ficha configurado nesta estação.");
      return normalized;
    } catch (error) {
      window.alert(error.message);
      return "";
    }
  }

  function configuredSiteUrl() {
    const saved = GM_getValue(SITE_URL_KEY, "");
    if (!saved) return configureSiteUrl();
    try {
      return normalizeSiteUrl(saved);
    } catch {
      GM_setValue(SITE_URL_KEY, "");
      return configureSiteUrl();
    }
  }

  function openRecord(siteUrl, patientId) {
    const url = new URL(siteUrl);
    url.searchParams.set("paciente", patientId);
    if (typeof GM_openInTab === "function") {
      GM_openInTab(url.href, { active: true, setParent: true });
    } else {
      window.open(url.href, "_blank", "noopener");
    }
  }

  async function handleImport(button, animalRoot) {
    const originalText = button.textContent;
    const patient = extractPatient(animalRoot);
    if (!patient.ciplexAnimalId) {
      window.alert("Não foi possível identificar o ID do animal aberto no Ciplex.");
      return;
    }
    if (inFlightAnimalIds.has(patient.ciplexAnimalId)) return;
    const siteUrl = configuredSiteUrl();
    if (!siteUrl) return;

    inFlightAnimalIds.add(patient.ciplexAnimalId);
    button.disabled = true;
    button.textContent = "Enviando...";
    try {
      const result = await sendPatient(patient);
      button.textContent = result.created ? "Ficha criada" : "Abrindo ficha";
      openRecord(siteUrl, result.internacao.id);
    } catch (error) {
      window.alert(error.message);
    } finally {
      inFlightAnimalIds.delete(patient.ciplexAnimalId);
      window.setTimeout(() => {
        button.disabled = false;
        button.textContent = originalText;
      }, 1500);
    }
  }

  function addButton(animalRoot) {
    const registration = animalRoot.querySelector('[id^="cadastro-animal-"]');
    const anchor = registration?.querySelector("button.salvarFechar");
    if (!anchor || registration.querySelector(`.${BUTTON_CLASS}`)) return;

    const button = document.createElement("button");
    button.type = "button";
    button.className = `btn btn-white btn-round btn-minier btn-info ${BUTTON_CLASS}`;
    button.style.marginLeft = "4px";
    button.textContent = "Enviar para internação";
    button.addEventListener("click", () => handleImport(button, animalRoot));
    anchor.insertAdjacentElement("afterend", button);
  }

  function injectButtons() {
    document.querySelectorAll(".tab-pane.animal").forEach(addButton);
  }

  function scheduleInjection() {
    window.clearTimeout(injectionTimer);
    injectionTimer = window.setTimeout(injectButtons, 120);
  }

  const observer = new MutationObserver(scheduleInjection);
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("hashchange", scheduleInjection);
  injectButtons();
})();
