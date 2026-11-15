# portaria-encomendas

Sistema de gestão de encomendas para portaria, com registro de entrada e saída, cadastro de moradores e leitura inteligente de etiquetas por câmera com OCR.

## Funcionalidades
- Registro de encomendas com nome do morador, apartamento e transportadora
- Leitura de etiquetas por câmera ou galeria com OCR em português
- Sugestão automática de campos pela IA / memória local
- Cadastro de moradores e familiares
- Controle de entrada e saída da encomenda
- Geração de PDF diário e de backup
- Armazenamento local no navegador/aplicativo

## Requisitos
- Node.js 20+
- npm
- Android Studio (para abrir e gerar APK)

## Instalação
```bash
npm install
```

## Build web
```bash
npm run build
```

## Android / Capacitor
```bash
npx cap add android
npx cap sync android
npx cap open android
```

## Exportar APK
O repositório inclui o workflow em `.github/workflows/build-apk.yml` para compilar o APK automaticamente pelo GitHub Actions.

## Observação importante
O app usa OCR via Tesseract.js no navegador. A leitura pode sugerir os dados automaticamente, mas sempre deve ser conferida antes de salvar. Os registros ficam no armazenamento local do dispositivo e podem ser exportados em PDF para backup.
