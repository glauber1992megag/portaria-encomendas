# Portaria Encomendas

Aplicativo mobile para gestão de entrada e saída de encomendas em portarias, condomínios e prédios.

## Descrição

O Portaria Encomendas foi criado para facilitar o controle de entregas e organizar o fluxo de encomendas no dia a dia da portaria. O sistema permite que o responsável registre cada encomenda, identifique o morador pela câmera, leia informações da etiqueta, acompanhe o status da entrega e mantenha um histórico diário em PDF.

O app foi pensado para uso em celular, especialmente em dispositivos Android, com interface simples, rápida e prática para operação no ambiente da portaria.

## Objetivo

Simplificar a rotina de recebimento e entrega de encomendas, reduzindo erros manuais, economizando tempo e mantendo um controle organizado de cada movimentação.

## Funcionalidades

- Cadastro de moradores e apartamentos
- Cadastro de familiares por unidade
- Registro de encomendas recebidas
- Leitura de etiqueta por câmera ou galeria
- OCR para preenchimento automático de dados
- Identificação do morador e do apartamento
- Registro de entrada e saída da encomenda
- Controle por status: pendente e retirada
- Edição e exclusão de registros
- Histórico diário em PDF
- Armazenamento local no dispositivo
- Compatibilidade com build Android via Capacitor
- Suporte para uso offline

## Fluxo de uso

1. O porteiro abre o app no celular.
2. Tira uma foto da etiqueta da encomenda ou escolhe uma imagem da galeria.
3. O sistema tenta ler o texto da etiqueta.
4. Os dados são preenchidos automaticamente.
5. O usuário confirma ou corrige as informações.
6. A encomenda é salva com status pendente.
7. Quando a entrega é feita, o responsável registra a saída.
8. O histórico é atualizado e salvo em PDF.

## Tecnologias

- HTML
- JavaScript
- CSS
- React
- Capacitor
- Android
- OCR com Tesseract
- Geração de PDF com jsPDF
- GitHub Actions para build automatizado do APK

## Requisitos

- Node.js 20+
- npm
- Android Studio (para build local do APK)
- Permissões de câmera e armazenamento no celular

## Instalação

Clone o projeto:

```bash
git clone https://github.com/glauber1992megag/portaria-encomendas.git
cd portaria-encomendas
```

Instale as dependências:

```bash
npm install
```

## Build da aplicação web

```bash
npm run build
```

Esse comando gera a pasta `www` com a versão web da aplicação.

## Preparar o projeto para Android

```bash
npx cap add android
npx cap sync android
```

## Gerar APK do Android

Na pasta do Android:

```bash
cd android
./gradlew assembleDebug
```

O APK será gerado em:

```bash
android/app/build/outputs/apk/debug/
```

## Estrutura do projeto

```text
portaria-encomendas/
├── .github/
│   └── workflows/
│       └── build-apk.yml
├── android/
├── src/
├── capacitor.config.json
├── index.html
├── package.json
├── README.md
└── .gitignore
```

## GitHub Actions

O projeto inclui um workflow para criar automaticamente um APK para Android em cada push para as branches principais.

Arquivo:

```text
.github/workflows/build-apk.yml
```

Esse workflow:
- faz checkout do código;
- configura o Node.js;
- instala dependências;
- gera a build web;
- prepara o Android via Capacitor;
- compila o APK com Gradle;
- publica o artefato gerado.

## Observações

- O app foi pensado para uso mobile e Android.
- A leitura da etiqueta depende da câmera e do OCR.
- Os dados são armazenados localmente para uso offline.
- O projeto pode ser expandido com backend, sincronização em nuvem e notificações.

## Licença

Este projeto é voltado para uso interno, educacional e operacional em portarias e condomínios.

## Resumo em uma frase

Sistema mobile para controlar encomendas de portaria, com leitura de etiqueta por câmera, registro de entrada e saída e geração de relatórios em PDF.
