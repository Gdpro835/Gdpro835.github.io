import { applyBpsPatch, BpsError, inspectBpsPatch } from './bps.mjs';

const PATCH_URL = new URL('./files/s1patch.bps', import.meta.url);
const EXPECTED_PATCH = {
  sourceSize: 524288,
  targetSize: 915280,
  sourceCrc32: 0xafe05eee,
  targetCrc32: 0xce9279c3,
  patchCrc32: 0x0664ddc1,
  sha256: 'b024cc1d453b5138e2dd18800107b6d1fb35f5de18e0f1ca0b3cc0b2afe94e72',
};

const messages = {
  ru: {
    title: 'Sonic 1 Definitive — BPS-патч для Sega Genesis',
    enableLight: 'Включить светлую тему',
    enableDark: 'Включить тёмную тему',
    openMenu: 'Открыть меню',
    closeMenu: 'Закрыть меню',
    copied: 'Скопировано в буфер обмена',
    copyFailed: 'Не удалось скопировать. Выделите значение и скопируйте его вручную.',
    shareCopied: 'Ссылка на сайт скопирована',
    shareFailed: 'Не удалось поделиться ссылкой',
    noFile: 'Файл не выбран',
    fileSelected: 'Файл выбран. Проверьте его и соберите ROM.',
    patchChecking: 'Проверяем файл патча…',
    patchVerified: 'Патч исправен: BPS-контрольная сумма совпала.',
    patchVerifiedStrong: 'Патч проверен: BPS CRC32 и SHA-256 совпадают.',
    patchFailed: 'Не удалось проверить патч.',
    readingSource: 'Читаем ROM локально и проверяем патч…',
    applying: 'Контрольные суммы совпали. Создаём ROM…',
    applied: 'Готово! Патч применён, контрольная сумма результата совпала. Скачайте файл ниже.',
    sourceSizeMismatch: (actual, expected) => `Неподходящий размер: ${actual}. Ожидается ${expected} (512 KiB). Проверьте, что выбран ROM без дополнительного заголовка.`,
    sourceChecksumMismatch: (actual, expected) => `CRC32 не совпадает: у выбранного файла ${actual}, у патча ожидается ${expected}. Нужен исходный ROM ревизии 01 без изменений.`,
    invalidSignature: 'Файл патча не распознан как BPS. Скачайте патч заново с этой страницы.',
    patchChecksumMismatch: 'Контрольная сумма BPS не совпала. Файл патча повреждён или изменён — скачайте его заново.',
    unexpectedPatch: 'Файл патча не совпадает с опубликованной версией Sonic 1 Definitive v2.0. Обновите страницу и попробуйте ещё раз.',
    targetChecksumMismatch: 'Результат не прошёл проверку CRC32. Исходный файл не изменён; скачайте патч заново.',
    targetTooLarge: 'Размер результата превышает безопасный лимит обработки в браузере.',
    malformedPatch: 'Структура патча повреждена. Скачайте его заново.',
    fetchFailed: 'Не удалось загрузить патч с сайта. Проверьте соединение или скачайте файл отдельно.',
    genericFailure: 'Не удалось обработать файл. Проверьте ROM и попробуйте ещё раз.',
    copy: 'Скопировать',
  },
  en: {
    title: 'Sonic 1 Definitive — BPS patch for Sega Genesis',
    enableLight: 'Switch to light theme',
    enableDark: 'Switch to dark theme',
    openMenu: 'Open menu',
    closeMenu: 'Close menu',
    copied: 'Copied to clipboard',
    copyFailed: 'Could not copy. Select the value and copy it manually.',
    shareCopied: 'Page link copied',
    shareFailed: 'Could not share the page link',
    noFile: 'No file selected',
    fileSelected: 'File selected. Verify it and build the ROM.',
    patchChecking: 'Verifying the patch file…',
    patchVerified: 'Patch is valid: BPS checksum matches.',
    patchVerifiedStrong: 'Patch verified: BPS CRC32 and SHA-256 match.',
    patchFailed: 'Could not verify the patch.',
    readingSource: 'Reading the ROM locally and checking the patch…',
    applying: 'Checksums match. Building the ROM…',
    applied: 'Done! The patch was applied and the output checksum matches. Download your file below.',
    sourceSizeMismatch: (actual, expected) => `Wrong file size: ${actual}. Expected ${expected} (512 KiB). Make sure the ROM does not have an extra header.`,
    sourceChecksumMismatch: (actual, expected) => `CRC32 mismatch: your file is ${actual}; the patch expects ${expected}. Use the unmodified revision 01 source ROM.`,
    invalidSignature: 'This file is not a recognized BPS patch. Download the patch again from this page.',
    patchChecksumMismatch: 'The BPS checksum does not match. The patch may be damaged or altered; download it again.',
    unexpectedPatch: 'This file does not match the published Sonic 1 Definitive v2.0 patch. Reload the page and try again.',
    targetChecksumMismatch: 'The output failed its CRC32 check. Your source file was not changed; download the patch again.',
    targetTooLarge: 'The output exceeds the safe in-browser processing limit.',
    malformedPatch: 'The patch data is damaged. Download it again.',
    fetchFailed: 'Could not load the patch from this site. Check your connection or download the file separately.',
    genericFailure: 'Could not process this file. Check the ROM and try again.',
    copy: 'Copy',
  },
};

const root = document.documentElement;
const languageButtons = [...document.querySelectorAll('[data-language]')];
const themeToggle = document.getElementById('theme-toggle');
const menuToggle = document.getElementById('menu-toggle');
const navigation = document.getElementById('primary-navigation');
const toast = document.getElementById('toast');
const romInput = document.getElementById('rom-file');
const dropZone = document.getElementById('rom-drop-zone');
const selectedFile = document.getElementById('selected-file');
const applyButton = document.getElementById('apply-patch-button');
const outputDownload = document.getElementById('output-download');
const romStatus = document.getElementById('rom-status');
const patchStatus = document.getElementById('patch-status');
const verifyPatchButton = document.getElementById('verify-patch-button');
let currentLanguage = 'ru';
let currentTheme = 'dark';
let currentRom = null;
let isApplying = false;
let patchPromise = null;
let outputObjectUrl = null;
let toastTimer = null;

function readPreference(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function savePreference(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // The page remains usable when browser storage is unavailable.
  }
}

function setLanguage(language, persist = true) {
  currentLanguage = language === 'en' ? 'en' : 'ru';
  root.lang = currentLanguage;
  document.title = messages[currentLanguage].title;

  languageButtons.forEach((button) => {
    const active = button.dataset.language === currentLanguage;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });

  document.querySelector('.site-nav')?.setAttribute(
    'aria-label',
    currentLanguage === 'ru' ? 'Основная навигация' : 'Primary navigation',
  );
  document.querySelector('.hero-facts')?.setAttribute(
    'aria-label',
    currentLanguage === 'ru' ? 'Краткая информация' : 'Quick facts',
  );
  document.querySelector('.quick-strip')?.setAttribute(
    'aria-label',
    currentLanguage === 'ru' ? 'Ключевые особенности' : 'Highlights',
  );

  document.querySelectorAll('[data-alt-ru][data-alt-en]').forEach((image) => {
    image.alt = image.dataset[currentLanguage === 'ru' ? 'altRu' : 'altEn'];
  });

  document.querySelectorAll('.copy-button').forEach((button) => {
    button.setAttribute('aria-label', `${messages[currentLanguage].copy}: ${button.dataset.copyValue}`);
    button.title = messages[currentLanguage].copy;
  });

  updateToggleLabels();
  if (persist) savePreference('s1def-language', currentLanguage);
}

function setTheme(theme, persist = true) {
  currentTheme = theme === 'light' ? 'light' : 'dark';
  root.dataset.theme = currentTheme;
  const isLight = currentTheme === 'light';
  themeToggle?.setAttribute('aria-pressed', String(isLight));
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', isLight ? '#f4f6f8' : '#07111d');
  updateToggleLabels();
  if (persist) savePreference('s1def-theme', currentTheme);
}

function updateToggleLabels() {
  if (themeToggle) {
    const label = currentTheme === 'dark' ? messages[currentLanguage].enableLight : messages[currentLanguage].enableDark;
    themeToggle.setAttribute('aria-label', label);
    themeToggle.title = label;
  }
  if (menuToggle) {
    const label = menuToggle.getAttribute('aria-expanded') === 'true'
      ? messages[currentLanguage].closeMenu
      : messages[currentLanguage].openMenu;
    menuToggle.setAttribute('aria-label', label);
    menuToggle.title = label;
  }
}

function setMenuOpen(open) {
  const isOpen = Boolean(open);
  navigation?.classList.toggle('is-open', isOpen);
  menuToggle?.setAttribute('aria-expanded', String(isOpen));
  updateToggleLabels();
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('is-visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 2800);
}

async function copyText(text) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const temporaryInput = document.createElement('textarea');
  temporaryInput.value = text;
  temporaryInput.setAttribute('readonly', '');
  temporaryInput.style.position = 'fixed';
  temporaryInput.style.opacity = '0';
  document.body.append(temporaryInput);
  temporaryInput.select();
  const copied = document.execCommand('copy');
  temporaryInput.remove();
  if (!copied) throw new Error('Clipboard access is unavailable.');
}

function formatBytes(bytes) {
  if (bytes % 1024 === 0) return `${bytes / 1024} KiB`;
  if (bytes < 1024) return `${bytes} bytes`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function formatCrc(value) {
  return value.toString(16).padStart(8, '0').toUpperCase();
}

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function getVerifiedPatch() {
  if (!patchPromise) {
    patchPromise = (async () => {
      const response = await fetch(PATCH_URL, { cache: 'no-cache' });
      if (!response.ok) throw new Error('Patch request failed.');
      const bytes = new Uint8Array(await response.arrayBuffer());
      const info = inspectBpsPatch(bytes);

      const matchesPublishedPatch = info.sourceSize === EXPECTED_PATCH.sourceSize
        && info.targetSize === EXPECTED_PATCH.targetSize
        && info.sourceCrc32 === EXPECTED_PATCH.sourceCrc32
        && info.targetCrc32 === EXPECTED_PATCH.targetCrc32
        && info.patchCrc32 === EXPECTED_PATCH.patchCrc32;
      if (!matchesPublishedPatch) {
        throw new BpsError('unexpected-patch', 'The patch metadata does not match the published build.');
      }

      let sha256Verified = false;
      if (globalThis.crypto?.subtle && window.isSecureContext) {
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        const sha256 = bytesToHex(digest);
        if (sha256 !== EXPECTED_PATCH.sha256) {
          throw new BpsError('unexpected-patch', 'The patch SHA-256 does not match the published build.');
        }
        sha256Verified = true;
      }

      return { bytes, info, sha256Verified };
    })();
  }

  try {
    return await patchPromise;
  } catch (error) {
    patchPromise = null;
    throw error;
  }
}

function describeBpsError(error, fallback = 'genericFailure') {
  const copy = messages[currentLanguage];
  if (!(error instanceof BpsError)) return copy[fallback];

  if (error.code === 'source-size-mismatch') {
    return copy.sourceSizeMismatch(formatBytes(error.details.actual), formatBytes(error.details.expected));
  }
  if (error.code === 'source-checksum-mismatch') {
    return copy.sourceChecksumMismatch(formatCrc(error.details.actual), formatCrc(error.details.expected));
  }
  if (error.code === 'invalid-signature') return copy.invalidSignature;
  if (error.code === 'patch-checksum-mismatch') return copy.patchChecksumMismatch;
  if (error.code === 'unexpected-patch') return copy.unexpectedPatch;
  if (error.code === 'target-checksum-mismatch') return copy.targetChecksumMismatch;
  if (error.code === 'target-too-large') return copy.targetTooLarge;
  if (error.code === 'malformed-patch') return copy.malformedPatch;
  return copy.genericFailure;
}

function setStatus(element, message, state = '') {
  if (!element) return;
  element.textContent = message;
  if (state) element.dataset.state = state;
  else delete element.dataset.state;
  element.setAttribute('aria-busy', String(state === 'checking'));
}

function clearOutput() {
  outputDownload.hidden = true;
  outputDownload.removeAttribute('href');
  if (outputObjectUrl) {
    URL.revokeObjectURL(outputObjectUrl);
    outputObjectUrl = null;
  }
}

function chooseRom(file) {
  if (!file || isApplying) return;
  currentRom = file;
  clearOutput();
  applyButton.disabled = false;
  selectedFile.textContent = `${file.name} · ${formatBytes(file.size)}`;
  setStatus(romStatus, messages[currentLanguage].fileSelected, '');
}

function initializePreferences() {
  const savedLanguage = readPreference('s1def-language');
  const browserLanguage = navigator.language?.toLowerCase() ?? '';
  const initialLanguage = savedLanguage === 'ru' || savedLanguage === 'en'
    ? savedLanguage
    : browserLanguage.startsWith('en') ? 'en' : 'ru';
  const savedTheme = readPreference('s1def-theme');

  setLanguage(initialLanguage, false);
  setTheme(savedTheme === 'light' ? 'light' : 'dark', false);
}

languageButtons.forEach((button) => {
  button.addEventListener('click', () => setLanguage(button.dataset.language));
});

themeToggle?.addEventListener('click', () => {
  setTheme(currentTheme === 'dark' ? 'light' : 'dark');
});

menuToggle?.addEventListener('click', () => {
  setMenuOpen(menuToggle.getAttribute('aria-expanded') !== 'true');
});

navigation?.querySelectorAll('a').forEach((link) => {
  link.addEventListener('click', () => setMenuOpen(false));
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') setMenuOpen(false);
});

document.querySelectorAll('.copy-button').forEach((button) => {
  button.addEventListener('click', async () => {
    try {
      await copyText(button.dataset.copyValue);
      showToast(messages[currentLanguage].copied);
    } catch {
      showToast(messages[currentLanguage].copyFailed);
    }
  });
});

document.getElementById('share-button')?.addEventListener('click', async () => {
  const shareData = {
    title: document.title,
    text: currentLanguage === 'ru'
      ? 'Sonic 1 Definitive — фанатский ROM-хак для Sega Genesis.'
      : 'Sonic 1 Definitive — a fan-made ROM hack for Sega Genesis.',
    url: window.location.href,
  };

  if (navigator.share) {
    try {
      await navigator.share(shareData);
      return;
    } catch (error) {
      if (error.name === 'AbortError') return;
    }
  }

  try {
    await copyText(shareData.url);
    showToast(messages[currentLanguage].shareCopied);
  } catch {
    showToast(messages[currentLanguage].shareFailed);
  }
});

verifyPatchButton?.addEventListener('click', async () => {
  verifyPatchButton.disabled = true;
  setStatus(patchStatus, messages[currentLanguage].patchChecking, 'checking');
  try {
    const { sha256Verified } = await getVerifiedPatch();
    setStatus(
      patchStatus,
      sha256Verified ? messages[currentLanguage].patchVerifiedStrong : messages[currentLanguage].patchVerified,
      'success',
    );
  } catch (error) {
    setStatus(patchStatus, describeBpsError(error, 'fetchFailed'), 'error');
  } finally {
    verifyPatchButton.disabled = false;
  }
});

romInput?.addEventListener('change', () => chooseRom(romInput.files?.[0]));

dropZone?.addEventListener('dragover', (event) => {
  event.preventDefault();
  dropZone.classList.add('is-dragging');
});

dropZone?.addEventListener('dragleave', (event) => {
  if (!(event.relatedTarget instanceof Node) || !dropZone.contains(event.relatedTarget)) {
    dropZone.classList.remove('is-dragging');
  }
});

dropZone?.addEventListener('drop', (event) => {
  event.preventDefault();
  dropZone.classList.remove('is-dragging');
  chooseRom(event.dataTransfer?.files?.[0]);
});

applyButton?.addEventListener('click', async () => {
  if (!currentRom || isApplying) return;
  const romFile = currentRom;
  clearOutput();

  if (romFile.size !== EXPECTED_PATCH.sourceSize) {
    setStatus(
      romStatus,
      messages[currentLanguage].sourceSizeMismatch(formatBytes(romFile.size), formatBytes(EXPECTED_PATCH.sourceSize)),
      'error',
    );
    return;
  }

  isApplying = true;
  applyButton.disabled = true;
  if (romInput) romInput.disabled = true;
  setStatus(romStatus, messages[currentLanguage].readingSource, 'checking');

  // Let assistive technology and the browser paint the status before work begins.
  await new Promise((resolve) => requestAnimationFrame(resolve));

  try {
    const { bytes: patchBytes } = await getVerifiedPatch();
    const sourceBytes = new Uint8Array(await romFile.arrayBuffer());
    setStatus(romStatus, messages[currentLanguage].applying, 'checking');
    const result = applyBpsPatch(sourceBytes, patchBytes);
    outputObjectUrl = URL.createObjectURL(new Blob([result.bytes], { type: 'application/octet-stream' }));
    outputDownload.href = outputObjectUrl;
    outputDownload.hidden = false;
    setStatus(romStatus, messages[currentLanguage].applied, 'success');
  } catch (error) {
    setStatus(romStatus, describeBpsError(error), 'error');
  } finally {
    isApplying = false;
    if (romInput) romInput.disabled = false;
    applyButton.disabled = !currentRom;
  }
});

initializePreferences();
