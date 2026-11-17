const RESIDENTS_STORAGE_KEY = 'portaria_mobile_residents_v1';

function normalizeHeader(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleUpperCase('pt-BR')
    .replace(/[^A-Z0-9]/g, '');
}

function parseCsv(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const separators = [',', ';', '\t'];
  const separator = separators.reduce((best, candidate) => {
    const count = firstLine.split(candidate).length - 1;
    return count > best.count ? { separator: candidate, count } : best;
  }, { separator: ',', count: -1 }).separator;

  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === separator && !quoted) {
      row.push(cell.trim());
      cell = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell.trim());
      if (row.some(value => value !== '')) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += character;
    }
  }

  row.push(cell.trim());
  if (row.some(value => value !== '')) rows.push(row);
  return rows;
}

function columnIndex(headers, candidates) {
  const normalizedHeaders = headers.map(normalizeHeader);
  return normalizedHeaders.findIndex(header => candidates.includes(header));
}

function parseResidentsCsv(text) {
  const rows = parseCsv(text.replace(/^\uFEFF/, ''));
  if (rows.length < 2) throw new Error('O CSV não contém linhas de moradores.');

  const headers = rows[0];
  const nameColumn = columnIndex(headers, ['NOME', 'MORADOR', 'MORADORESPROPRIETARIOS', 'MORADORES', 'PROPRIETARIOS']);
  const apartmentColumn = columnIndex(headers, ['APARTAMENTO', 'APTO', 'UNIDADE', 'BLOCOAPARTAMENTO']);
  const phoneColumn = columnIndex(headers, ['TELEFONE', 'CELULAR', 'NUMERODECELULAR', 'TELEFONECELULAR', 'CONTATO']);

  if (nameColumn < 0 || apartmentColumn < 0) {
    throw new Error('Não encontrei as colunas de nome e apartamento. Confira os cabeçalhos do CSV.');
  }

  return rows
    .slice(1)
    .map(row => ({
      name: String(row[nameColumn] || '').trim(),
      apartment: String(row[apartmentColumn] || '').trim(),
      phone: phoneColumn >= 0 ? String(row[phoneColumn] || '').trim() : '',
    }))
    .filter(resident => resident.name && resident.apartment);
}

function residentKey(resident) {
  return `${normalizeHeader(resident.name)}|${normalizeHeader(resident.apartment)}`;
}

function makeId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
}

export function enableResidentCsvImport() {
  const attachImportControl = () => {
    const heading = [...document.querySelectorAll('.panel h2')].find(element =>
      /^(cadastrar|editar) morador$/i.test(element.textContent.trim())
    );
    const panel = heading?.closest('.panel');
    if (!panel || panel.querySelector('[data-resident-csv-import]')) return;

    const section = document.createElement('div');
    section.dataset.residentCsvImport = 'true';
    section.className = 'resident-import';

    section.innerHTML = `
      <p class="help-text">
        Importe um CSV com nome e apartamento. Telefone/celular é opcional; outras colunas,
        como OBS, serão ignoradas. Os dados ficam somente neste aparelho.
      </p>
      <button type="button" class="button secondary full" data-import-trigger>
        Importar moradores de CSV
      </button>
      <input
        type="file"
        accept=".csv,text/csv"
        hidden
        data-import-file
        aria-label="Selecionar arquivo CSV de moradores"
      />
    `;

    const form = panel.querySelector('form');
    if (form) panel.insertBefore(section, form);

    const fileInput = section.querySelector('[data-import-file]');
    section.querySelector('[data-import-trigger]').addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', async event => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;

      try {
        const imported = parseResidentsCsv(await file.text());
        if (!imported.length) throw new Error('Nenhum morador válido foi encontrado no CSV.');

        const savedResidents = JSON.parse(localStorage.getItem(RESIDENTS_STORAGE_KEY) || '[]');
        if (!Array.isArray(savedResidents)) {
          throw new Error('Os cadastros salvos no aparelho estão em formato inesperado.');
        }

        const existingKeys = new Set(savedResidents.map(residentKey));
        const seenKeys = new Set();

        const additions = imported
          .filter(resident => {
            const key = residentKey(resident);
            if (existingKeys.has(key) || seenKeys.has(key)) return false;
            seenKeys.add(key);
            return true;
          })
          .map(resident => ({
            ...resident,
            id: makeId(),
            photo: '',
            family: [],
          }));

        const skipped = imported.length - additions.length;

        if (!additions.length) {
          window.alert(
            `Nenhum cadastro novo foi importado. ${skipped} linha(s) já existiam ou estavam repetidas. Os moradores existentes foram preservados.`
          );
          return;
        }

        const confirmed = window.confirm(
          `Adicionar ${additions.length} morador(es) ao cadastro atual? ${
            skipped ? `${skipped} linha(s) repetidas serão ignoradas. ` : ''
          }Nenhum morador existente será duplicado.`
        );

        if (!confirmed) return;

        localStorage.setItem(
          RESIDENTS_STORAGE_KEY,
          JSON.stringify([...additions, ...savedResidents])
        );

        window.alert(
          `${additions.length} morador(es) importado(s). Os dados foram salvos somente neste aparelho.${
            skipped ? ` ${skipped} linha(s) repetidas foram ignoradas.` : ''
          }`
        );

        window.location.reload();
      } catch (error) {
        console.error('Falha ao importar CSV de moradores:', error);
        window.alert(error?.message || 'Não foi possível importar o CSV. Verifique o arquivo e tente novamente.');
      }
    });
  };

  attachImportControl();
  const observer = new MutationObserver(attachImportControl);
  observer.observe(document.getElementById('root') || document.body, { childList: true, subtree: true });
  return () => observer.disconnect();
}
