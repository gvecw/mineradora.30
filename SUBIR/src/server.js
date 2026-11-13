const fs = require('fs');
const path = require('path');
const express = require('express');
const {
  coletar,
  classificarAnunciantesCamada2,
  atualizarCriativosDoAnunciante,
} = require('./coletor');
const { listarAnunciantesAgrupados, limparBanco, db, criativosDir } = require('./db');
const { DOMINIOS_BLOQUEADOS } = require('./bloqueados');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
// Servir arquivos locais de data/criativos/ em /criativos/
app.use('/criativos', express.static(criativosDir));

// Criar tabela de favoritos (separada de anuncios, nunca apagada por Limpar resultados)
db.exec(`
  CREATE TABLE IF NOT EXISTS favoritos (
    page_id TEXT PRIMARY KEY,
    nome TEXT,
    link_pagina TEXT,
    link_biblioteca TEXT,
    dias_rodando INTEGER,
    data_favorito TEXT,
    nota TEXT DEFAULT '',
    status TEXT DEFAULT 'Analisar',
    local_video TEXT,
    local_thumb TEXT,
    local_imagem TEXT
  )
`);

const colsFav = db
  .prepare('PRAGMA table_info(favoritos)')
  .all()
  .map((c) => c.name);

if (!colsFav.includes('local_video')) {
  db.exec('ALTER TABLE favoritos ADD COLUMN local_video TEXT');
}
if (!colsFav.includes('local_thumb')) {
  db.exec('ALTER TABLE favoritos ADD COLUMN local_thumb TEXT');
}
if (!colsFav.includes('local_imagem')) {
  db.exec('ALTER TABLE favoritos ADD COLUMN local_imagem TEXT');
}

const upsertFavoritoStmt = db.prepare(`
  INSERT INTO favoritos (
    page_id,
    nome,
    link_pagina,
    link_biblioteca,
    dias_rodando,
    data_favorito,
    nota,
    status,
    local_video,
    local_thumb,
    local_imagem
  ) VALUES (
    @page_id,
    @nome,
    @link_pagina,
    @link_biblioteca,
    @dias_rodando,
    @data_favorito,
    @nota,
    @status,
    @local_video,
    @local_thumb,
    @local_imagem
  )
  ON CONFLICT(page_id) DO UPDATE SET
    nome = excluded.nome,
    link_pagina = COALESCE(excluded.link_pagina, favoritos.link_pagina),
    link_biblioteca = COALESCE(excluded.link_biblioteca, favoritos.link_biblioteca),
    dias_rodando = MAX(COALESCE(excluded.dias_rodando, 0), COALESCE(favoritos.dias_rodando, 0)),
    local_video = COALESCE(excluded.local_video, favoritos.local_video),
    local_thumb = COALESCE(excluded.local_thumb, favoritos.local_thumb),
    local_imagem = COALESCE(excluded.local_imagem, favoritos.local_imagem)
`);

async function baixarArquivoParaDisco(urlRemota, caminhoDestino) {
  if (!urlRemota || typeof urlRemota !== 'string' || !urlRemota.startsWith('http')) {
    return false;
  }
  try {
    const res = await fetch(urlRemota, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
    });
    if (!res.ok) return false;
    const arrayBuffer = await res.arrayBuffer();
    fs.writeFileSync(caminhoDestino, Buffer.from(arrayBuffer));
    return true;
  } catch (_) {
    return false;
  }
}

async function salvarCriativoTopLocal(pageId, videoUrl, thumbUrl, imagemUrl) {
  const pastaPage = path.join(criativosDir, String(pageId));
  if (!fs.existsSync(pastaPage)) {
    fs.mkdirSync(pastaPage, { recursive: true });
  }

  let localVideo = null;
  let localThumb = null;
  let localImagem = null;

  if (videoUrl) {
    const destVideo = path.join(pastaPage, 'top_video.mp4');
    const okVid = await baixarArquivoParaDisco(videoUrl, destVideo);
    if (okVid) {
      localVideo = `/criativos/${encodeURIComponent(pageId)}/top_video.mp4`;
    }
  }

  if (thumbUrl) {
    const destThumb = path.join(pastaPage, 'top_thumb.jpg');
    const okThumb = await baixarArquivoParaDisco(thumbUrl, destThumb);
    if (okThumb) {
      localThumb = `/criativos/${encodeURIComponent(pageId)}/top_thumb.jpg`;
    }
  }

  if (imagemUrl) {
    const destImg = path.join(pastaPage, 'top_imagem.jpg');
    const okImg = await baixarArquivoParaDisco(imagemUrl, destImg);
    if (okImg) {
      localImagem = `/criativos/${encodeURIComponent(pageId)}/top_imagem.jpg`;
    }
  }

  return { localVideo, localThumb, localImagem };
}

// Controle de estado e clientes SSE
let mineracaoAtiva = false;
let estadoAtual = {
  minerando: false,
  reclassificando: false,
  palavraAtual: null,
  indicePalavra: 0,
  totalPalavras: 0,
  paginaAtual: 0,
  maxPaginas: 10,
  totalSalvosSessao: 0,
  totalDescartadosSessao: 0,
  novosAnunciantesSessao: 0,
  ultimoAviso: null,
  rateLimit: false,
  concluido: false,
};

const sseClients = new Set();

function broadcastSSE(evento, dados) {
  const payload = `event: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch (_) {
      sseClients.delete(res);
    }
  }
}

// Endpoint SSE para progresso em tempo real
app.get('/api/progresso', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  sseClients.add(res);

  res.write(`event: estado\ndata: ${JSON.stringify(estadoAtual)}\n\n`);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

// Listar resultados agrupados por page_id
app.get('/api/resultados', (req, res) => {
  try {
    const anunciantes = listarAnunciantesAgrupados();
    const totalAnunciosBanco = db.prepare('SELECT COUNT(*) as total FROM anuncios').get().total;
    const favIds = new Set(
      db
        .prepare('SELECT page_id FROM favoritos')
        .all()
        .map((r) => String(r.page_id))
    );
    const enriquecidos = anunciantes.map((a) => ({
      ...a,
      favorito: favIds.has(String(a.page_id)),
    }));

    const contagemClassificacao = {
      low_ticket: 0,
      sem_preco: 0,
      caro: 0,
      loja: 0,
    };

    for (const item of enriquecidos) {
      const t = item.tipo_oferta || 'sem_preco';
      if (contagemClassificacao[t] !== undefined) {
        contagemClassificacao[t]++;
      } else {
        contagemClassificacao.sem_preco++;
      }
    }

    res.json({
      ok: true,
      totalAnunciantes: enriquecidos.length,
      totalAnunciosBanco,
      contagemClassificacao,
      bloqueados: DOMINIOS_BLOQUEADOS,
      resultados: enriquecidos,
    });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Limpar apenas resultados (tabela anuncios), mantendo favoritos intactos
app.delete('/api/resultados', (req, res) => {
  if (mineracaoAtiva) {
    return res.status(409).json({
      ok: false,
      erro: 'Aguarde a operação atual terminar antes de limpar os resultados.',
    });
  }
  try {
    const removidos = limparBanco();
    broadcastSSE('limpo', { removidos });
    res.json({ ok: true, removidos });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Atualizar criativos de um anunciante específico (Raio-X na Biblioteca sem login)
app.post('/api/atualizar-criativo/:pageId', async (req, res) => {
  if (mineracaoAtiva) {
    return res.status(409).json({
      ok: false,
      erro: 'Aguarde a mineração em andamento terminar antes de atualizar o criativo.',
    });
  }

  const pageId = String(req.params.pageId || '').trim();
  if (!pageId) {
    return res.status(400).json({ ok: false, erro: 'pageId inválido.' });
  }

  mineracaoAtiva = true;
  try {
    const { totalAtualizados } = await atualizarCriativosDoAnunciante(pageId);

    // Se também for uma favorita, atualiza os arquivos locais em data/criativos/PAGE_ID/
    const isFav = db.prepare('SELECT * FROM favoritos WHERE page_id = ?').get(pageId);
    const agrupados = listarAnunciantesAgrupados();
    const itemAtualizado = agrupados.find((a) => String(a.page_id) === pageId) || null;

    if (isFav && itemAtualizado) {
      const locais = await salvarCriativoTopLocal(
        pageId,
        itemAtualizado.video_url,
        itemAtualizado.thumb_url,
        itemAtualizado.imagem_url
      );
      db.prepare(`
        UPDATE favoritos
        SET local_video = COALESCE(?, local_video),
            local_thumb = COALESCE(?, local_thumb),
            local_imagem = COALESCE(?, local_imagem)
        WHERE page_id = ?
      `).run(locais.localVideo, locais.localThumb, locais.localImagem, pageId);
    }

    res.json({
      ok: true,
      totalAtualizados,
      anunciante: itemAtualizado,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      rateLimit: Boolean(err.isRateLimit),
      erro: err.message || 'Erro ao atualizar criativo.',
    });
  } finally {
    mineracaoAtiva = false;
  }
});

// Rota para baixar vídeo ou imagem no PC ("⬇️ Baixar")
app.get('/api/download-criativo', async (req, res) => {
  try {
    const { url, page_id, tipo } = req.query;
    const pid = String(page_id || 'anunciante').replace(/[^\w-]/g, '');

    // Se for caminho local (/criativos/...)
    if (url && typeof url === 'string' && url.startsWith('/criativos/')) {
      const rel = url.replace(/^\/criativos\//, '');
      const fullLocalPath = path.join(criativosDir, decodeURIComponent(rel));
      if (fs.existsSync(fullLocalPath)) {
        const ext = path.extname(fullLocalPath) || (tipo === 'video' ? '.mp4' : '.jpg');
        return res.download(fullLocalPath, `criativo_${pid}${ext}`);
      }
    }

    if (!url || typeof url !== 'string' || !url.startsWith('http')) {
      return res.status(400).send('URL de criativo inválida.');
    }

    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
    });

    if (!response.ok) {
      return res.status(502).send('Link do criativo expirado. Clique em Atualizar criativo.');
    }

    const contentType = response.headers.get('content-type') || '';
    const isVideo = contentType.includes('video') || url.includes('.mp4') || tipo === 'video';
    const ext = isVideo ? '.mp4' : '.jpg';

    res.setHeader('Content-Type', isVideo ? 'video/mp4' : 'image/jpeg');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="criativo_${pid}${ext}"`
    );

    const buffer = Buffer.from(await response.arrayBuffer());
    res.send(buffer);
  } catch (err) {
    res.status(500).send('Erro ao baixar criativo: ' + (err.message || err));
  }
});

// Reclassificar tudo (Camada 1 + Camada 2 em todos os anunciantes do banco)
app.post('/api/reclassificar', (req, res) => {
  if (mineracaoAtiva) {
    return res.status(409).json({
      ok: false,
      erro: 'Já existe uma mineração ou reclassificação em andamento.',
    });
  }

  mineracaoAtiva = true;
  estadoAtual.reclassificando = true;

  res.json({ ok: true, mensagem: 'Reclassificação iniciada!' });

  (async () => {
    broadcastSSE('reclassificacao_inicio', {
      mensagem: 'Iniciando reclassificação de todos os anunciantes (Camada 1 + Camada 2)...',
    });

    try {
      await classificarAnunciantesCamada2({
        forcarTodos: true,
        onProgress: (ev) => {
          broadcastSSE('reclassificacao_progresso', ev);
        },
      });
    } catch (err) {
      broadcastSSE('reclassificacao_erro', {
        mensagem: `Erro na reclassificação: ${err.message || err}`,
      });
    } finally {
      mineracaoAtiva = false;
      estadoAtual.reclassificando = false;
      const anunciantes = listarAnunciantesAgrupados();
      const resumo = { low_ticket: 0, sem_preco: 0, caro: 0, loja: 0 };
      for (const a of anunciantes) {
        const t = a.tipo_oferta || 'sem_preco';
        if (resumo[t] !== undefined) resumo[t]++;
      }
      broadcastSSE('reclassificacao_fim', {
        resumo,
        mensagem: `Reclassificação concluída! (${resumo.low_ticket} low_ticket, ${resumo.sem_preco} sem_preco, ${resumo.caro} caro, ${resumo.loja} loja)`,
      });
    }
  })();
});

// Rotas de FAVORITOS
app.get('/api/favoritos', (req, res) => {
  try {
    const favoritos = db
      .prepare('SELECT * FROM favoritos ORDER BY data_favorito DESC')
      .all();
    res.json({ ok: true, favoritos });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.post('/api/favoritos', async (req, res) => {
  try {
    const {
      page_id,
      nome,
      link_pagina,
      link_biblioteca,
      dias_rodando,
      video_url,
      thumb_url,
      imagem_url,
    } = req.body || {};

    if (!page_id) {
      return res.status(400).json({ ok: false, erro: 'page_id é obrigatório.' });
    }

    const pid = String(page_id);
    const bibDefault = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=BR&view_all_page_id=${encodeURIComponent(
      pid
    )}&search_type=page&media_type=all`;

    // Procura o criativo top no banco caso não tenha vindo no body
    const topAd = db
      .prepare(`
        SELECT video_url, thumb_url, imagem_url
        FROM anuncios
        WHERE page_id = ?
          AND (video_url IS NOT NULL OR thumb_url IS NOT NULL OR imagem_url IS NOT NULL)
        ORDER BY COALESCE(collation_count, 1) DESC, COALESCE(dias_rodando, 0) DESC
        LIMIT 1
      `)
      .get(pid);

    const vUrl = video_url || (topAd && topAd.video_url) || null;
    const tUrl = thumb_url || (topAd && topAd.thumb_url) || null;
    const iUrl = imagem_url || (topAd && topAd.imagem_url) || null;

    // Baixa o vídeo/imagem do criativo top para data/criativos/PAGE_ID/
    const { localVideo, localThumb, localImagem } = await salvarCriativoTopLocal(
      pid,
      vUrl,
      tUrl,
      iUrl
    );

    upsertFavoritoStmt.run({
      page_id: pid,
      nome: nome || 'Sem nome',
      link_pagina: link_pagina || '',
      link_biblioteca: link_biblioteca || bibDefault,
      dias_rodando: Number(dias_rodando) || 0,
      data_favorito: new Date().toISOString(),
      nota: '',
      status: 'Analisar',
      local_video: localVideo,
      local_thumb: localThumb,
      local_imagem: localImagem,
    });

    const favorito = db.prepare('SELECT * FROM favoritos WHERE page_id = ?').get(pid);
    res.json({ ok: true, favorito });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.patch('/api/favoritos/:pageId', (req, res) => {
  try {
    const pageId = String(req.params.pageId);
    const { nota, status } = req.body || {};

    const atual = db.prepare('SELECT * FROM favoritos WHERE page_id = ?').get(pageId);
    if (!atual) {
      return res.status(404).json({ ok: false, erro: 'Favorito não encontrado.' });
    }

    const novaNota = nota !== undefined ? String(nota) : atual.nota;
    const novoStatus = status !== undefined ? String(status) : atual.status;

    db.prepare('UPDATE favoritos SET nota = ?, status = ? WHERE page_id = ?').run(
      novaNota,
      novoStatus,
      pageId
    );

    const atualizado = db.prepare('SELECT * FROM favoritos WHERE page_id = ?').get(pageId);
    res.json({ ok: true, favorito: atualizado });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.delete('/api/favoritos/:pageId', (req, res) => {
  try {
    const pageId = String(req.params.pageId);
    db.prepare('DELETE FROM favoritos WHERE page_id = ?').run(pageId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Iniciar mineração
app.post('/api/minerar', async (req, res) => {
  if (mineracaoAtiva) {
    return res.status(409).json({
      ok: false,
      erro: 'Já existe uma mineração em andamento. Aguarde a conclusão.',
    });
  }

  const { palavras, paginasPorPalavra } = req.body || {};
  const listaPalavras = Array.isArray(palavras)
    ? palavras.map((p) => String(p).trim()).filter(Boolean)
    : String(palavras || '')
        .split(/\r?\n/)
        .map((p) => p.trim())
        .filter(Boolean);

  if (listaPalavras.length === 0) {
    return res.status(400).json({
      ok: false,
      erro: 'Informe pelo menos uma palavra-chave.',
    });
  }

  let maxPaginas = parseInt(paginasPorPalavra, 10);
  if (isNaN(maxPaginas) || maxPaginas < 1) maxPaginas = 10;
  if (maxPaginas > 20) maxPaginas = 20;

  const anunciantesAntes = new Set(
    db
      .prepare('SELECT DISTINCT page_id FROM anuncios WHERE page_id IS NOT NULL')
      .all()
      .map((r) => String(r.page_id))
  );

  mineracaoAtiva = true;
  estadoAtual = {
    minerando: true,
    reclassificando: false,
    palavraAtual: listaPalavras[0],
    indicePalavra: 1,
    totalPalavras: listaPalavras.length,
    paginaAtual: 0,
    maxPaginas,
    totalSalvosSessao: 0,
    totalDescartadosSessao: 0,
    novosAnunciantesSessao: 0,
    ultimoAviso: null,
    rateLimit: false,
    concluido: false,
  };

  res.json({
    ok: true,
    mensagem: 'Mineração iniciada!',
    palavras: listaPalavras,
    maxPaginas,
  });

  (async () => {
    let acumuladoSalvos = 0;
    let acumuladoDescartados = 0;
    let parouPorRateLimit = false;

    broadcastSSE('inicio', {
      ...estadoAtual,
      mensagem: `Iniciando mineração de ${listaPalavras.length} palavra(s)-chave (${maxPaginas} págs/palavra)...`,
    });

    for (let i = 0; i < listaPalavras.length; i++) {
      const palavra = listaPalavras[i];
      estadoAtual.palavraAtual = palavra;
      estadoAtual.indicePalavra = i + 1;
      estadoAtual.paginaAtual = 0;

      broadcastSSE('progresso', {
        ...estadoAtual,
        tipo: 'palavra_inicio',
        mensagem: `Palavra ${i + 1} de ${listaPalavras.length}: "${palavra}"`,
      });

      const salvosAntesDestaPalavra = acumuladoSalvos;
      const descartadosAntesDestaPalavra = acumuladoDescartados;
      let descartadosNestaPalavra = 0;

      try {
        const resultado = await coletar(palavra, {
          maxPaginas,
          onProgress: (ev) => {
            if (typeof ev.paginaAtual === 'number') {
              estadoAtual.paginaAtual = ev.paginaAtual;
            }
            if (typeof ev.salvosPalavra === 'number') {
              estadoAtual.totalSalvosSessao = salvosAntesDestaPalavra + ev.salvosPalavra;
            }
            if (typeof ev.qtdDescartados === 'number') {
              descartadosNestaPalavra += ev.qtdDescartados;
              estadoAtual.totalDescartadosSessao =
                descartadosAntesDestaPalavra + descartadosNestaPalavra;
            }
            if (ev.tipo === 'rate_limit') {
              estadoAtual.rateLimit = true;
              estadoAtual.ultimoAviso =
                'Facebook pediu pausa, espere alguns minutos (Rate limit detectado).';
            } else if (ev.tipo === 'erro' || ev.tipo === 'aviso') {
              estadoAtual.ultimoAviso = ev.mensagem;
            }

            broadcastSSE('progresso', {
              ...estadoAtual,
              ...ev,
            });
          },
        });

        acumuladoSalvos += resultado.totalSalvos || 0;
        acumuladoDescartados += resultado.totalDescartados || 0;
        estadoAtual.totalSalvosSessao = acumuladoSalvos;
        estadoAtual.totalDescartadosSessao = acumuladoDescartados;

        if (resultado.rateLimit) {
          parouPorRateLimit = true;
          break;
        }
      } catch (err) {
        const msgErro = `Erro ao minerar "${palavra}": ${err.message || err}`;
        estadoAtual.ultimoAviso = msgErro;
        broadcastSSE('progresso', {
          ...estadoAtual,
          tipo: 'erro',
          mensagem: msgErro,
        });
      }
    }

    const anunciantesDepois = db
      .prepare('SELECT DISTINCT page_id FROM anuncios WHERE page_id IS NOT NULL')
      .all()
      .map((r) => String(r.page_id));

    let novosAnunciantes = anunciantesDepois.filter((id) => !anunciantesAntes.has(id)).length;
    if (novosAnunciantes === 0 && acumuladoSalvos > 0) {
      novosAnunciantes = anunciantesDepois.length;
    }

    mineracaoAtiva = false;
    estadoAtual.minerando = false;
    estadoAtual.concluido = true;
    estadoAtual.novosAnunciantesSessao = novosAnunciantes;

    broadcastSSE('fim', {
      ...estadoAtual,
      rateLimit: parouPorRateLimit,
      novosAnunciantes,
      mensagem: parouPorRateLimit
        ? 'Facebook pediu pausa, espere alguns minutos.'
        : `Mineração concluída: ${novosAnunciantes} anunciantes novos`,
    });
  })();
});

app.listen(PORT, () => {
  console.log('====================================================');
  console.log(` MINERADORA 3.0 - SERVIDOR WEB ATIVO`);
  console.log(` Acesse: http://localhost:${PORT}`);
  console.log('====================================================');
});
