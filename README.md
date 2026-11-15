# portaria-encomendas

Sistema de gestão de encomendas para portaria, com registro de entrada, saída, cadastro de moradores e leitura de etiquetas por câmera com OCR.

## Funcionalidades previstas no app
- Registro de encomendas e identificação do morador/apartamento
- Leitura de etiquetas por câmera ou galeria com OCR em português
- Sugestão de preenchimento com base no texto da etiqueta e nas configurações locais
- Cadastro de moradores e familiares
- Controle de entrada e retirada das encomendas
- Exportação de relatórios diários em PDF
- Armazenamento local no dispositivo

## Requisitos
- Node.js 20 ou superior
- npm
- Android Studio para compilar ou abrir o projeto Android

## Instalação e build web
```bash
npm install
npm run build
```

## Android com Capacitor
```bash
npx cap add android
npx cap sync android
npx cap open android
```

Para gerar o APK, também é possível executar o workflow em `.github/workflows/build-apk.yml` pelo GitHub Actions e baixar o artefato gerado.

## Importante sobre OCR e dados
O OCR usa Tesseract.js carregado pela aplicação. A leitura reconhece texto da etiqueta e pode sugerir dados, mas é necessário conferir e corrigir os campos antes de salvar. Os registros ficam no armazenamento local do dispositivo; não são sincronizados entre aparelhos nem enviados automaticamente para um servidor. Faça exportações de PDF para manter cópias dos relatórios.
