# MP43 para Windows

App de desktop do MP43: baixa vídeos em MP4 e músicas em MP3 usando yt-dlp + FFmpeg (+ Deno para o YouTube),
com a mesma configuração do site (`C:\Users\vini_\mp43\server.js`), mas sem servidor nem navegador.

## Desenvolvimento

```
npm install
npm start       # abre o app
npm run dist    # gera o instalador em dist\
```

Diagnóstico (só fora da versão instalada): `MP43_DEBUG=1` mostra o console no terminal; `MP43_DIR=<pasta>`
troca a pasta de downloads; `MP43_SHOT=<arquivo.png>` salva uma captura e fecha (com `MP43_EVAL` opcional).

## Estrutura

- `main.js` – janela, IPC, configurações e histórico (em `%APPDATA%\MP43`)
- `src/downloader.js` – fila de downloads com o yt-dlp (até 3 ao mesmo tempo)
- `src/tools.js` – localiza yt-dlp/FFmpeg/Deno embutidos e atualiza o yt-dlp (`yt-dlp -U`)
- `renderer/` – interface

## Componentes embutidos

yt-dlp, FFmpeg/ffprobe e Deno vão dentro do instalador (pasta `vendor\`, ~390 MB; instalador ~200 MB).
Para atualizar as versões embutidas antes de gerar um instalador novo:

```
winget upgrade yt-dlp.yt-dlp ; winget upgrade yt-dlp.FFmpeg ; winget upgrade DenoLand.Deno
powershell -ExecutionPolicy Bypass -File scripts\fetch-vendor.ps1
npm run dist
```

O yt-dlp é copiado para `%APPDATA%\MP43\bin` na primeira execução e se atualiza pelo botão
"Atualizar yt-dlp" (Configurações), que roda `yt-dlp -U`.

Licenças: `vendor\AVISOS-DE-LICENCA.txt`. O FFmpeg é GPLv3 — ao distribuir o MP43 publicamente,
mantenha esse aviso e o texto da licença, e atenda pedidos do código-fonte do FFmpeg.

## Playlists

Um link de playlist (ex.: `youtube.com/playlist?list=...`) mostra a lista de vídeos com caixas de seleção;
cada vídeo marcado vira um download separado na fila, salvo numa subpasta com o nome da playlist.
Num link `watch?v=...&list=...` o app baixa só o vídeo, mas oferece "Ver a playlist inteira".

## Observações

- O instalador não é assinado digitalmente (o SmartScreen pode avisar na primeira execução).
