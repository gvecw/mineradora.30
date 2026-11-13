const { chromium } = require('playwright');
const {
  salvarAnuncios,
  atualizarClassificacaoAnunciante,
  obterResumo,
  classificarLink,
  db,
  dbPath,
} = require('./db');
const { classificarCamada1Texto, analisarPaginaComPlaywright } = require('./classificador');

const DEFAULT_MAX_PAGINAS = 10;
const LIMITE_MAX_PAGINAS = 20;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extrairMidiasDoSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return { videoUrl: null, thumbUrl: null, imagemUrl: null };
  }

  const videos = Array.isArray(snapshot.videos) ? snapshot.videos : [];
  const images = Array.isArray(snapshot.images) ? snapshot.images : [];
  const cards = Array.isArray(snapshot.cards) ? snapshot.cards : [];
  const card0 = cards[0] || {};
  const card0Videos = Array.isArray(card0.videos) ? card0.videos : [];
  const card0Images = Array.isArray(card0.images) ? card0.images : [];

  // 1. video_url: snapshot.videos[0].video_hd_url ou video_sd_url (fallback snapshot.cards[0])
  let videoUrl = null;
  if (videos[0]) {
    videoUrl = videos[0].video_hd_url || videos[0].video_sd_url || null;
  }
  if (!videoUrl && card0) {
    videoUrl =
      card0.video_hd_url ||
      card0.video_sd_url ||
      (card0Videos[0] && (card0Videos[0].video_hd_url || card0Videos[0].video_sd_url)) ||
      null;
  }

  // 2. thumb_url: snapshot.videos[0].video_preview_image_url (fallback snapshot.cards[0])
  let thumbUrl = null;
  if (videos[0]) {
    thumbUrl = videos[0].video_preview_image_url || null;
  }
  if (!thumbUrl && card0) {
    thumbUrl =
      card0.video_preview_image_url ||
      (card0Videos[0] && card0Videos[0].video_preview_image_url) ||
      null;
  }

  // 3. imagem_url: snapshot.images[0].original_image_url ou resized_image_url (fallback snapshot.cards[0])
  let imagemUrl = null;
  if (images[0]) {
    imagemUrl = images[0].original_image_url || images[0].resized_image_url || null;
  }
  if (!imagemUrl && card0) {
    imagemUrl =
      card0.original_image_url ||
      card0.resized_image_url ||
      (card0Images[0] &&
        (card0Images[0].original_image_url || card0Images[0].resized_image_url)) ||
      null;
  }

  return { videoUrl, thumbUrl, imagemUrl };
}

function extrairAnuncioBruto(item, palavraChave, dataColetaIso, agoraUnix) {
  const adArchiveId = item.ad_archive_id ? String(item.ad_archive_id) : null;
  if (!adArchiveId) return null;

  const snapshot = item.snapshot || {};
  const pageId = String(item.page_id || snapshot.page_id || '');
  const pageName = item.page_name || snapshot.page_name || 'Desconhecido';

  const startDate =
    typeof item.start_date === 'number'
      ? item.start_date
      : typeof snapshot.creation_time === 'number'
      ? snapshot.creation_time
      : null;

  let diasRodando = 0;
  if (startDate && startDate > 0) {
    diasRodando = Math.max(0, Math.floor((agoraUnix - startDate) / 86400));
  }

  const collationCount =
    typeof item.collation_count === 'number' && item.collation_count > 0
      ? item.collation_count
      : 1;

  const cards = Array.isArray(snapshot.cards) ? snapshot.cards : [];
  const rawLinkUrl = snapshot.link_url || (cards[0] && cards[0].link_url) || null;
  const ctaType = snapshot.cta_type || (cards[0] && cards[0].cta_type) || '';
  const ctaText = snapshot.cta_text || (cards[0] && cards[0].cta_text) || '';

  let rawTexto = '';
  if (snapshot.body && typeof snapshot.body.text === 'string') {
    rawTexto = snapshot.body.text;
  } else if (cards[0] && cards[0].body) {
    rawTexto =
      typeof cards[0].body === 'string' ? cards[0].body : cards[0].body.text || '';
  }
  const texto = rawTexto ? rawTexto.trim().substring(0, 300) : null;

  const { videoUrl, thumbUrl, imagemUrl } = extrairMidiasDoSnapshot(snapshot);

  return {
    ad_archive_id: adArchiveId,
    page_id: pageId,
    page_name: pageName,
    start_date: startDate,
    dias_rodando: diasRodando,
    collation_count: collationCount,
    raw_link_url: rawLinkUrl,
    cta_type: ctaType,
    cta_text: ctaText,
    texto: texto,
    palavra_chave: palavraChave,
    data_coleta: dataColetaIso,
    video_url: videoUrl,
    thumb_url: thumbUrl,
    imagem_url: imagemUrl,
  };
}

function extrairListaDaConexao(searchResultsConnection, palavraChave) {
  const edges =
    searchResultsConnection && Array.isArray(searchResultsConnection.edges)
      ? searchResultsConnection.edges
      : [];
  const pageInfo = (searchResultsConnection && searchResultsConnection.page_info) || {};
  const dataColetaIso = new Date().toISOString();
  const agoraUnix = Math.floor(Date.now() / 1000);

  const anunciosRecebidos = [];
  const anunciosValidos = [];
  let qtdPagina = 0;
  let qtdWhatsapp = 0;
  let qtdDescartados = 0;

  for (const edge of edges) {
    const node = (edge && edge.node) || {};
    const collatedResults = Array.isArray(node.collated_results)
      ? node.collated_results
      : node.ad_archive_id
      ? [node]
      : [];

    for (const item of collatedResults) {
      const bruto = extrairAnuncioBruto(item, palavraChave, dataColetaIso, agoraUnix);
      if (!bruto) continue;

      anunciosRecebidos.push(bruto);
      const classif = classificarLink(
        bruto.raw_link_url,
        bruto.texto,
        bruto.cta_type,
        bruto.cta_text
      );

      if (classif.tipo === 'descartar') {
        qtdDescartados++;
        continue;
      }

      if (classif.tipo === 'pagina') qtdPagina++;
      if (classif.tipo === 'whatsapp') qtdWhatsapp++;

      const isWa = classif.tipo === 'whatsapp';
      const c1 = classificarCamada1Texto(bruto.texto || '');

      anunciosValidos.push({
        ad_archive_id: bruto.ad_archive_id,
        page_id: bruto.page_id,
        page_name: bruto.page_name,
        start_date: bruto.start_date,
        dias_rodando: bruto.dias_rodando,
        collation_count: bruto.collation_count,
        link_url: classif.linkLimpo,
        tipo: classif.tipo,
        whatsapp: classif.whatsapp !== null && classif.whatsapp !== undefined ? String(classif.whatsapp) : '',
        texto: bruto.texto,
        palavra_chave: bruto.palavra_chave,
        data_coleta: bruto.data_coleta,
        tipo_oferta: isWa ? 'sem_preco' : c1.tipoOfertaInicial,
        preco_min: null,
        preco_max: null,
        checkout: null,
        motivo_filtro: isWa ? 'whatsapp: preço a conferir' : c1.motivoCamada1,
        video_url: bruto.video_url,
        thumb_url: bruto.thumb_url,
        imagem_url: bruto.imagem_url,
      });
    }
  }

  return {
    anunciosRecebidos,
    anuncios: anunciosValidos,
    qtdPagina,
    qtdWhatsapp,
    qtdDescartados,
    endCursor: pageInfo.end_cursor || null,
    hasNextPage: Boolean(pageInfo.has_next_page),
  };
}

function parsePrimeiraLinhaJson(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    throw new Error('Resposta vazia.');
  }
  if (rawText.includes('Rate limit exceeded') || rawText.includes('Rate Limit Exceeded')) {
    const err = new Error('RATE_LIMIT_EXCEEDED');
    err.isRateLimit = true;
    throw err;
  }

  const linhas = rawText.split(/\r?\n/).filter((l) => l.trim().startsWith('{'));
  const primeiraLinha = linhas.length > 0 ? linhas[0] : rawText.split(/\r?\n/)[0];
  const parsed = JSON.parse(primeiraLinha);

  if (parsed.errors && Array.isArray(parsed.errors)) {
    const msgErro = JSON.stringify(parsed.errors);
    if (msgErro.toLowerCase().includes('rate limit exceeded')) {
      const err = new Error('RATE_LIMIT_EXCEEDED');
      err.isRateLimit = true;
      throw err;
    }
  }

  return parsed;
}

/**
 * Raio-X / Atualizar criativos de um anunciante específico na Biblioteca (por page_id)
 * Sem login, mesmas regras de espera (3-6s) e de Rate limit.
 */
async function atualizarCriativosDoAnunciante(pageId) {
  if (!pageId) throw new Error('pageId inválido.');

  const rowExistente = db
    .prepare('SELECT palavra_chave, page_name FROM anuncios WHERE page_id = ? LIMIT 1')
    .get(String(pageId));
  const palavraChavePadrao = (rowExistente && rowExistente.palavra_chave) || 'raio-x';

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });

  const context = await browser.newContext({
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 900 },
  });

  const page = await context.newPage();

  let capturedGraphqlBody = null;
  let capturedGraphqlHeaders = null;
  let capturedGraphqlUrl = 'https://www.facebook.com/api/graphql/';
  let rateLimitDetectado = false;
  const conexoesCapturadasDiretas = [];

  page.on('response', async (response) => {
    try {
      const url = response.url();
      const request = response.request();
      if (url.includes('/api/graphql') && request.method() === 'POST') {
        const text = await response.text().catch(() => '');
        if (text.includes('Rate limit exceeded') || text.includes('Rate Limit Exceeded')) {
          rateLimitDetectado = true;
          return;
        }
        if (text.includes('search_results_connection')) {
          if (!capturedGraphqlBody) {
            capturedGraphqlBody = request.postData();
            capturedGraphqlHeaders = request.headers();
            capturedGraphqlUrl = url;
          }
          try {
            const parsed = parsePrimeiraLinhaJson(text);
            const conn =
              parsed &&
              parsed.data &&
              parsed.data.ad_library_main &&
              parsed.data.ad_library_main.search_results_connection;
            if (conn) conexoesCapturadasDiretas.push(conn);
          } catch (_) {}
        }
      }
    } catch (_) {}
  });

  let totalAtualizados = 0;

  try {
    const targetUrl = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=BR&view_all_page_id=${encodeURIComponent(
      pageId
    )}&search_type=page&media_type=all`;

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Espera de segurança aleatória entre 3 e 6 segundos
    const waitMs = Math.floor(Math.random() * (6000 - 3000 + 1)) + 3000;
    await sleep(waitMs);

    const htmlInicial = await page.content().catch(() => '');
    if (
      rateLimitDetectado ||
      htmlInicial.includes('Rate limit exceeded') ||
      htmlInicial.includes('Rate Limit Exceeded')
    ) {
      const err = new Error('Facebook pediu pausa, espere alguns minutos (Rate limit exceeded).');
      err.isRateLimit = true;
      throw err;
    }

    // Rola para disparar paginação GraphQL da página do anunciante
    for (let tentativa = 1; tentativa <= 8 && !capturedGraphqlBody && !rateLimitDetectado; tentativa++) {
      await page.evaluate(() => window.scrollBy(0, 1200));
      await sleep(1200);
    }

    if (rateLimitDetectado) {
      const err = new Error('Facebook pediu pausa, espere alguns minutos (Rate limit exceeded).');
      err.isRateLimit = true;
      throw err;
    }

    // 1) Processa conexões já interceptadas na abertura/rolagem
    for (const conn of conexoesCapturadasDiretas) {
      const { anuncios } = extrairListaDaConexao(conn, palavraChavePadrao);
      totalAtualizados += salvarAnuncios(anuncios);
    }

    // 2) Se capturou o body GraphQL, faz uma busca via fetch com viewAllPageID = pageId
    if (capturedGraphqlBody) {
      const delayFetch = Math.floor(Math.random() * (6000 - 3000 + 1)) + 3000;
      await sleep(delayFetch);

      const params = new URLSearchParams(capturedGraphqlBody);
      let vars = {};
      try {
        vars = JSON.parse(params.get('variables') || '{}');
      } catch (_) {}

      vars.viewAllPageID = String(pageId);
      vars.searchType = 'page';
      vars.queryString = '';
      vars.cursor = null;
      vars.first = 30;
      vars.startDate = null;
      params.set('variables', JSON.stringify(vars));

      const customHeaders = { 'content-type': 'application/x-www-form-urlencoded' };
      if (capturedGraphqlHeaders) {
        if (capturedGraphqlHeaders['x-fb-friendly-name']) {
          customHeaders['x-fb-friendly-name'] = capturedGraphqlHeaders['x-fb-friendly-name'];
        }
        if (capturedGraphqlHeaders['x-asbd-id']) {
          customHeaders['x-asbd-id'] = capturedGraphqlHeaders['x-asbd-id'];
        }
        if (capturedGraphqlHeaders['x-fb-lsd']) {
          customHeaders['x-fb-lsd'] = capturedGraphqlHeaders['x-fb-lsd'];
        }
      }

      const rawResponse = await page.evaluate(
        async ({ url, body, headers }) => {
          const res = await fetch(url, {
            method: 'POST',
            headers,
            body,
            credentials: 'same-origin',
          });
          return await res.text();
        },
        { url: capturedGraphqlUrl, body: params.toString(), headers: customHeaders }
      );

      const json = parsePrimeiraLinhaJson(rawResponse);
      const conn =
        json &&
        json.data &&
        json.data.ad_library_main &&
        json.data.ad_library_main.search_results_connection;
      if (conn) {
        const { anuncios } = extrairListaDaConexao(conn, palavraChavePadrao);
        totalAtualizados += salvarAnuncios(anuncios);
      }
    }

    // 3) Fallback: se o anunciante tiver menos de 10 anúncios e o Facebook embutiu tudo no HTML inicial sem disparar POST
    if (totalAtualizados === 0 && htmlInicial.includes('search_results_connection')) {
      const regexJson = /"search_results_connection":(\{"edges":\[.+?\],"page_info":\{.+?\}\})/g;
      let match;
      while ((match = regexJson.exec(htmlInicial)) !== null) {
        try {
          const conn = JSON.parse(match[1]);
          const { anuncios } = extrairListaDaConexao(conn, palavraChavePadrao);
          totalAtualizados += salvarAnuncios(anuncios);
        } catch (_) {}
      }
    }
  } finally {
    await browser.close();
  }

  return { totalAtualizados };
}

/**
 * Executa a CAMADA 2 (visita a página link_url uma por vez com timeout 20s)
 */
async function classificarAnunciantesCamada2({ browser, forcarTodos = false, onProgress = () => {} } = {}) {
  let ownBrowser = false;
  let activeBrowser = browser;

  if (!activeBrowser) {
    activeBrowser = await chromium.launch({
      headless: true,
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    });
    ownBrowser = true;
  }

  try {
    if (forcarTodos) {
      const todosAnuncios = db.prepare('SELECT ad_archive_id, texto FROM anuncios').all();
      const upC1 = db.prepare(`
        UPDATE anuncios
        SET tipo_oferta = @tipo_oferta,
            preco_min = NULL,
            preco_max = NULL,
            checkout = NULL,
            motivo_filtro = @motivo_filtro
        WHERE ad_archive_id = @ad_archive_id
      `);
      const tx = db.transaction((rows) => {
        for (const r of rows) {
          const c1 = classificarCamada1Texto(r.texto || '');
          upC1.run({
            ad_archive_id: r.ad_archive_id,
            tipo_oferta: c1.tipoOfertaInicial,
            motivo_filtro: c1.motivoCamada1,
          });
        }
      });
      tx(todosAnuncios);
    }

    const anunciantesParaAnalisar = db
      .prepare(`
        SELECT
          page_id,
          MAX(page_name) AS page_name,
          MAX(CASE WHEN tipo = 'pagina' AND link_url IS NOT NULL AND link_url != '' THEN link_url ELSE NULL END) AS link_url,
          MAX(tipo) AS tipo
        FROM anuncios
        WHERE page_id IS NOT NULL AND page_id != ''
          AND tipo = 'pagina'
          AND (tipo_oferta IS NULL OR tipo_oferta = '')
        GROUP BY page_id
      `)
      .all();

    const total = anunciantesParaAnalisar.length;
    if (total === 0) {
      return { analisados: 0 };
    }

    const context = await activeBrowser.newContext({
      locale: 'pt-BR',
      timezoneId: 'America/Sao_Paulo',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });

    const page = await context.newPage();

    for (let i = 0; i < total; i++) {
      const an = anunciantesParaAnalisar[i];
      onProgress({
        tipo: 'classificando_pagina',
        atual: i + 1,
        total,
        page_id: an.page_id,
        page_name: an.page_name,
        link_url: an.link_url,
        mensagem: `Analisando página ${i + 1} de ${total}: ${an.page_name} (${an.link_url || 'sem site'})`,
      });

      const resCamada2 = await analisarPaginaComPlaywright(page, an.link_url);
      atualizarClassificacaoAnunciante(an.page_id, resCamada2);
    }

    await context.close();
    return { analisados: total };
  } finally {
    if (ownBrowser && activeBrowser) {
      await activeBrowser.close();
    }
  }
}

async function coletar(palavraChave, options = {}) {
  const maxPaginasSolicitado = Number(options.maxPaginas) || DEFAULT_MAX_PAGINAS;
  const maxPaginas = Math.min(Math.max(1, maxPaginasSolicitado), LIMITE_MAX_PAGINAS);
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};

  const emitir = (evento) => {
    try {
      onProgress({ palavra: palavraChave, ...evento });
    } catch (_) {}
  };

  console.log('====================================================');
  console.log(` MINERADORA 3.0 - COLETOR`);
  console.log(` Palavra-chave: "${palavraChave}"`);
  console.log(` Limite de segurança: ${maxPaginas} páginas`);
  console.log('====================================================\n');

  emitir({
    tipo: 'status',
    mensagem: `Iniciando palavra "${palavraChave}" (até ${maxPaginas} páginas)...`,
    paginaAtual: 0,
    maxPaginas,
  });

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });

  const context = await browser.newContext({
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 900 },
  });

  const page = await context.newPage();

  let capturedGraphqlBody = null;
  let capturedGraphqlHeaders = null;
  let capturedGraphqlUrl = 'https://www.facebook.com/api/graphql/';
  let rateLimitDetectado = false;

  page.on('response', async (response) => {
    try {
      const url = response.url();
      const request = response.request();
      if (url.includes('/api/graphql') && request.method() === 'POST') {
        const text = await response.text().catch(() => '');
        if (text.includes('Rate limit exceeded') || text.includes('Rate Limit Exceeded')) {
          rateLimitDetectado = true;
          return;
        }
        if (text.includes('search_results_connection') && !capturedGraphqlBody) {
          capturedGraphqlBody = request.postData();
          capturedGraphqlHeaders = request.headers();
          capturedGraphqlUrl = url;
          console.log('[OK] Requisição POST /api/graphql/ (search_results_connection) capturada!');
        }
      }
    } catch (_) {}
  });

  let totalSalvosNestaExecucao = 0;
  let totalPaginaNestaExecucao = 0;
  let totalWhatsappNestaExecucao = 0;
  let totalDescartadosNestaExecucao = 0;

  try {
    const targetUrl = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=BR&q=${encodeURIComponent(
      palavraChave
    )}&search_type=keyword_unordered&media_type=all`;

    console.log(`[1/3] Abrindo página sem login:\n      ${targetUrl}`);
    emitir({
      tipo: 'status',
      mensagem: `Abrindo Biblioteca de Anúncios para "${palavraChave}"...`,
      paginaAtual: 0,
      maxPaginas,
    });

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    await sleep(4000);

    const conteudoInicial = await page.content().catch(() => '');
    if (
      rateLimitDetectado ||
      conteudoInicial.includes('Rate limit exceeded') ||
      conteudoInicial.includes('Rate Limit Exceeded')
    ) {
      const msg = '[ALERTA DE SEGURANÇA] "Rate limit exceeded" detectado! Parando tudo imediatamente.';
      console.error('\n' + msg);
      emitir({ tipo: 'rate_limit', mensagem: msg });
      return { totalSalvos: totalSalvosNestaExecucao, rateLimit: true };
    }

    console.log('[2/3] Rolando a página para capturar o body da requisição /api/graphql/...');
    emitir({
      tipo: 'status',
      mensagem: `Rolando página para capturar sessão GraphQL de "${palavraChave}"...`,
      paginaAtual: 0,
      maxPaginas,
    });

    for (let tentativa = 1; tentativa <= 15 && !capturedGraphqlBody && !rateLimitDetectado; tentativa++) {
      await page.evaluate(() => {
        window.scrollBy(0, 1200);
      });
      await sleep(1500);
    }

    if (rateLimitDetectado) {
      const msg =
        '[ALERTA DE SEGURANÇA] "Rate limit exceeded" detectado durante a rolagem! Parando tudo imediatamente.';
      console.error('\n' + msg);
      emitir({ tipo: 'rate_limit', mensagem: msg });
      return { totalSalvos: totalSalvosNestaExecucao, rateLimit: true };
    }

    if (!capturedGraphqlBody) {
      const msgErro =
        'Não foi possível capturar a requisição POST para /api/graphql/ com "search_results_connection" após rolar a página.';
      emitir({ tipo: 'erro', mensagem: msgErro });
      throw new Error(msgErro);
    }

    console.log(`[3/3] Iniciando coleta paginada via fetch interno (máx ${maxPaginas} páginas)...\n`);

    let cursor = null;
    let hasNextPage = true;

    for (let pagina = 1; pagina <= maxPaginas && hasNextPage; pagina++) {
      const waitMs = Math.floor(Math.random() * (6000 - 3000 + 1)) + 3000;
      emitir({
        tipo: 'aguardando',
        paginaAtual: pagina,
        maxPaginas,
        salvosPalavra: totalSalvosNestaExecucao,
        mensagem: `Palavra "${palavraChave}" — Aguardando ${(waitMs / 1000).toFixed(1)}s antes da página ${pagina}/${maxPaginas}...`,
      });
      await sleep(waitMs);

      const params = new URLSearchParams(capturedGraphqlBody);
      let variablesObj = {};
      try {
        variablesObj = JSON.parse(params.get('variables') || '{}');
      } catch (_) {
        variablesObj = {};
      }

      variablesObj.queryString = palavraChave;
      variablesObj.cursor = pagina === 1 ? null : cursor;
      variablesObj.first = 30;
      variablesObj.searchType = 'keyword_unordered';
      variablesObj.viewAllPageID = '0';
      variablesObj.startDate = null;

      params.set('variables', JSON.stringify(variablesObj));
      const newBodyString = params.toString();

      const customHeaders = {
        'content-type': 'application/x-www-form-urlencoded',
      };
      if (capturedGraphqlHeaders) {
        if (capturedGraphqlHeaders['x-fb-friendly-name']) {
          customHeaders['x-fb-friendly-name'] = capturedGraphqlHeaders['x-fb-friendly-name'];
        }
        if (capturedGraphqlHeaders['x-asbd-id']) {
          customHeaders['x-asbd-id'] = capturedGraphqlHeaders['x-asbd-id'];
        }
        if (capturedGraphqlHeaders['x-fb-lsd']) {
          customHeaders['x-fb-lsd'] = capturedGraphqlHeaders['x-fb-lsd'];
        }
      }

      const rawResponse = await page.evaluate(
        async ({ url, body, headers }) => {
          const res = await fetch(url, {
            method: 'POST',
            headers,
            body,
            credentials: 'same-origin',
          });
          return await res.text();
        },
        {
          url: capturedGraphqlUrl,
          body: newBodyString,
          headers: customHeaders,
        }
      );

      let json;
      try {
        json = parsePrimeiraLinhaJson(rawResponse);
      } catch (err) {
        if (err.isRateLimit) {
          const msg =
            '[ALERTA DE SEGURANÇA] "Rate limit exceeded" recebido do Facebook! Parando tudo na hora.';
          console.error('\n' + msg);
          emitir({ tipo: 'rate_limit', mensagem: msg });
          return { totalSalvos: totalSalvosNestaExecucao, rateLimit: true };
        }
        const msgParse = `Página ${pagina} com erro ao fazer parse. Primeiros 200 caracteres da resposta: ${String(
          rawResponse || ''
        ).substring(0, 200)}`;
        console.error(msgParse);
        emitir({ tipo: 'erro', paginaAtual: pagina, maxPaginas, mensagem: msgParse });
        break;
      }

      const connection =
        json &&
        json.data &&
        json.data.ad_library_main &&
        json.data.ad_library_main.search_results_connection
          ? json.data.ad_library_main.search_results_connection
          : null;

      if (!connection || !Array.isArray(connection.edges) || connection.edges.length === 0) {
        const msgVazia = `Página ${pagina}: 0 anúncios recebidos, has_next_page: false`;
        const trecho = String(rawResponse || '').substring(0, 200);
        console.log(msgVazia);
        console.log(`Resposta vazia ou com erro (primeiros 200 caracteres): ${trecho}`);
        emitir({
          tipo: 'aviso',
          paginaAtual: pagina,
          maxPaginas,
          salvosPalavra: totalSalvosNestaExecucao,
          mensagem: `${msgVazia} | Primeiros 200 chars: ${trecho}`,
        });
        break;
      }

      const endCursor = connection.page_info ? connection.page_info.end_cursor : null;
      hasNextPage = Boolean(connection.page_info && connection.page_info.has_next_page);

      const {
        anunciosRecebidos,
        anuncios,
        qtdPagina,
        qtdWhatsapp,
        qtdDescartados,
      } = extrairListaDaConexao(connection, palavraChave);

      const salvos = salvarAnuncios(anuncios);
      totalSalvosNestaExecucao += salvos;
      totalPaginaNestaExecucao += qtdPagina;
      totalWhatsappNestaExecucao += qtdWhatsapp;
      totalDescartadosNestaExecucao += qtdDescartados;

      const msgPagina = `Página ${pagina}: ${anunciosRecebidos.length} anúncios recebidos, has_next_page: ${hasNextPage}`;
      console.log(
        `${msgPagina} -> [página: ${qtdPagina}, whatsapp: ${qtdWhatsapp}, descartados: ${qtdDescartados}]`
      );

      emitir({
        tipo: 'pagina',
        paginaAtual: pagina,
        maxPaginas,
        recebidosPagina: anunciosRecebidos.length,
        salvosPagina: salvos,
        qtdPagina,
        qtdWhatsapp,
        qtdDescartados,
        salvosPalavra: totalSalvosNestaExecucao,
        hasNextPage,
        mensagem: `${msgPagina} (${qtdPagina} página, ${qtdWhatsapp} whatsapp, ${qtdDescartados} descartados)`,
      });

      if (!hasNextPage || !endCursor) {
        break;
      }

      cursor = endCursor;
    }

    await context.close();

    console.log('\n[CAMADA 2] Analisando páginas dos anunciantes novos (Filtro Low Ticket)...');
    await classificarAnunciantesCamada2({
      browser,
      forcarTodos: false,
      onProgress: (ev) => {
        console.log(`  -> ${ev.mensagem}`);
        emitir(ev);
      },
    });
  } finally {
    await browser.close();
  }

  const resumo = obterResumo(palavraChave);

  console.log('\n====================================================');
  console.log(' RESUMO FINAL DA COLETA');
  console.log('====================================================');
  console.log(` Banco de dados           : ${dbPath}`);
  console.log(` Palavra-chave            : "${palavraChave}"`);
  console.log(` Classificados (sessão)   : ${totalPaginaNestaExecucao} página | ${totalWhatsappNestaExecucao} whatsapp | ${totalDescartadosNestaExecucao} descartados`);
  console.log(` Anúncios salvos agora    : ${totalSalvosNestaExecucao}`);
  console.log(` Total de anúncios salvos : ${resumo.totalAnuncios} (${resumo.totalPaginas} página, ${resumo.totalWhatsapp} whatsapp)`);
  console.log(` Anunciantes diferentes   : ${resumo.totalAnunciantes}`);
  console.log('====================================================\n');

  emitir({
    tipo: 'palavra_concluida',
    salvosPalavra: totalSalvosNestaExecucao,
    totalPagina: totalPaginaNestaExecucao,
    totalWhatsapp: totalWhatsappNestaExecucao,
    totalDescartados: totalDescartadosNestaExecucao,
    mensagem: `Palavra "${palavraChave}" finalizada: ${totalPaginaNestaExecucao} página, ${totalWhatsappNestaExecucao} WhatsApp, ${totalDescartadosNestaExecucao} descartados.`,
  });

  return {
    totalSalvos: totalSalvosNestaExecucao,
    totalPagina: totalPaginaNestaExecucao,
    totalWhatsapp: totalWhatsappNestaExecucao,
    totalDescartados: totalDescartadosNestaExecucao,
    rateLimit: false,
    resumo,
  };
}

if (require.main === module) {
  const palavraChaveArg = process.argv.slice(2).join(' ').trim();
  if (!palavraChaveArg) {
    console.error('Uso: node src/coletor.js "<palavra-chave>"');
    console.error('Exemplo: node src/coletor.js "moldes"');
    process.exit(1);
  }

  coletar(palavraChaveArg).catch((err) => {
    console.error('\n[ERRO FATAL]:', err.message || err);
    process.exit(1);
  });
}

module.exports = {
  coletar,
  classificarAnunciantesCamada2,
  atualizarCriativosDoAnunciante,
};
