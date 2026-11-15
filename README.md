# Portaria Encomendas — aplicativo Android

Aplicativo móvel para registrar o recebimento e a retirada de encomendas em portarias. A interface é desenvolvida em React e empacotada como APK Android com Capacitor.

## Funcionalidades
- Cadastro e busca local de moradores
- Registro de encomendas com morador, apartamento, transportadora e observações
- Captura de foto pela câmera do celular ou seleção da galeria
- OCR em português para sugerir dados da etiqueta
- Sugestões de transportadoras e reconhecimento local de moradores cadastrados
- Registro de quem retirou a encomenda e horário
- Histórico diário e exportação de relatórios em PDF
- Interface responsiva para celular

> O OCR é uma leitura assistida por regras locais, não uma identificação garantida. Revise os dados antes de salvar. Os dados ficam no armazenamento local deste aparelho; não há sincronização entre celulares.

## Requisitos para desenvolvimento
- Node.js 20 ou superior
- npm
- Android Studio (para compilar/instalar localmente)

## Instalar dependências e executar no navegador
```bash
npm install
npm run dev
```

## Gerar os arquivos web e sincronizar Android
```bash
npm run build
npx cap add android   # somente na primeira configuração, se android/ ainda não existir
npx cap sync android
npx cap open android
```

No Android Studio, gere um APK de teste pelo menu **Build > Build Bundle(s) / APK(s) > Build APK(s)**.

## GitHub Actions
O workflow `.github/workflows/build-apk.yml` compila um APK de depuração ao enviar alterações para `main`, `master` ou `principal`, ou quando executado manualmente. Após a execução terminar com sucesso, baixe `portaria-encomendas-debug-apk` na seção **Artifacts** da execução do workflow.

## Dados e conectividade
Os cadastros e registros são guardados no armazenamento local do app. Exporte PDFs periodicamente como cópias. O OCR em português pode precisar baixar os dados de idioma na primeira utilização e, por isso, requer internet nessa etapa; não desinstale o app nem limpe os dados sem exportar uma cópia dos registros.
