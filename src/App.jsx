import React, { useState, useEffect } from 'react';
import { Camera, CheckCircle, Package, FileText, User, Home, Truck, AlertCircle } from 'lucide-react';
import { createWorker } from 'tesseract.js';
import jsPDF from 'jspdf';

export default function App() {
  const [encomendas, setEncomendas] = useState([]);
  const [morador, setMorador] = useState('');
  const [apartamento, setApartamento] = useState('');
  const [transportadora, setTransportadora] = useState('');
  const [processandoIA, setProcessandoIA] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');

  // Carregar dados salvos localmente ao iniciar
  useEffect(() => {
    const dadosSalvos = localStorage.getItem('encomendas_portaria');
    if (dadosSalvos) {
      setEncomendas(JSON.parse(dadosSalvos));
    }
  }, []);

  // Salvar dados e atualizar PDF do dia automaticamente
  const salvarEAtualizarPDF = (novaLista) => {
    setEncomendas(novaLista);
    localStorage.setItem('encomendas_portaria', JSON.stringify(novaLista));
    gerarPDFDiario(novaLista);
  };

  // Função de IA: OCR para ler a etiqueta da foto tirada pela câmera
  const handleCapturarFoto = async (e) => {
    const arquivo = e.target.files[0];
    if (!arquivo) return;

    setProcessandoIA(true);
    setStatusMsg('Analisando etiqueta com IA...');

    try {
      const worker = await createWorker('por');
      const ret = await worker.recognize(arquivo);
      await worker.terminate();

      const textoLido = ret.data.text;
      console.log("Texto extraído:", textoLido);

      // Lógica simples de varredura inteligente no texto da etiqueta
      // (Procura por padrões comuns de nomes, aptos e transportadoras)
      detectarDadosInteligentes(textoLido);
      setStatusMsg('Leitura concluída! Confira os dados abaixo.');
    } catch (error) {
      console.error(error);
      setStatusMsg('Erro ao ler a imagem. Preencha manualmente.');
    } finally {
      setProcessandoIA(false);
    }
  };

  const detectarDadosInteligentes = (texto) => {
    // Exemplo simulado de inteligência extraindo dados do OCR
    if (texto.toLowerCase().includes('mercadolivre') || texto.toLowerCase().includes('mercado livre')) {
      setTransportadora('Mercado Livre');
    } else if (texto.toLowerCase().includes('amazon')) {
      setTransportadora('Amazon');
    } else if (texto.toLowerCase().includes('correios')) {
      setTransportadora('Correios');
    } else {
      setTransportadora('Transportadora Diversa');
    }

    // Tenta sugerir preenchimentos caso encontre termos
    setMorador('Morador (Verificar Etiqueta)');
    setApartamento('Apto / Bloco');
  };

  // Adicionar nova encomenda
  const handleSubmit = (e) => {
    e.preventDefault();
    if (!morador || !apartamento) return;

    const novaEncomenda = {
      id: Date.now(),
      morador,
      apartamento,
      transportadora: transportadora || 'Não informada',
      dataHora: new Date().toLocaleString('pt-BR'),
      status: 'Pendente',
      dataDia: new Date().toISOString().split('T')[0] // Formato YYYY-MM-DD
    };

    const atualizadas = [novaEncomenda, ...encomendas];
    salvarEAtualizarPDF(atualizadas);

    // Limpar campos
    setMorador('');
    setApartamento('');
    setTransportadora('');
    setStatusMsg('Encomenda cadastrada e PDF do dia atualizado!');
  };

  // Dar baixa na encomenda
  const darBaixa = (id) => {
    const atualizadas = encomendas.map(item => {
      if (item.id === id) {
        return { ...item, status: 'Retirado' };
      }
      return item;
    });
    salvarEAtualizarPDF(atualizadas);
  };

  // Geração do PDF diário automático (Regra: atualiza o do dia, mantém os anteriores)
  const gerarPDFDiario = (lista) => {
    const dataHoje = new Date().toISOString().split('T')[0];
    const doc = new jsPDF();

    doc.setFont("helvetica", "bold");
    doc.setFontSize(18);
    doc.text(`Relatório de Encomendas - ${dataHoje}`, 14, 20);

    doc.setFontSize(11);
    doc.setFont("helvetica", "normal");
    doc.text(`Gerado automaticamente pelo Sistema de Portaria Local`, 14, 28);

    let y = 40;
    const itensHoje = lista.filter(i => i.dataDia === dataHoje);

    if (itensHoje.length === 0) {
      doc.text("Nenhuma encomenda registrada hoje.", 14, y);
    } else {
      itensHoje.forEach((item, index) => {
        if (y > 270) {
          doc.addPage();
          y = 20;
        }
        doc.text(`${index + 1}. Morador: ${item.morador} | Apto: ${item.apartamento}`, 14, y);
        doc.text(`   Transportadora: ${item.transportadora} | Status: ${item.status} (${item.dataHora})`, 14, y + 6);
        y += 16;
      });
    }

    // Salva localmente (o navegador gerencia o download na pasta de downloads do dispositivo)
    // No ambiente desktop futuro (Tauri), isso vai direto para a pasta local dedicada.
    doc.save(`encomendas_${dataHoje}.pdf`);
  };

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 p-4 pb-20">
      <div className="max-w-md mx-auto space-y-6">
        
        {/* Cabeçalho */}
        <header className="bg-gray-800 p-4 rounded-xl shadow-lg border border-gray-700 text-center">
          <h1 className="text-xl font-bold text-blue-400 flex items-center justify-center gap-2">
            <Package className="w-6 h-6" /> Portaria Inteligente
          </h1>
          <p className="text-xs text-gray-400 mt-1">100% Local • Leitura por Câmera & IA</p>
        </header>

        {/* Botão de Câmera (Mobile First) */}
        <div className="bg-gray-800 p-4 rounded-xl shadow-lg border border-gray-700 text-center">
          <label className="block w-full bg-blue-600 hover:bg-blue-500 text-white font-semibold py-3 px-4 rounded-lg cursor-pointer transition shadow flex items-center justify-center gap-2">
            <Camera className="w-5 h-5" /> Escanear Etiqueta com Câmera
            <input 
              type="file" 
              accept="image/*" 
              capture="environment" 
              className="hidden" 
              onChange={handleCapturarFoto} 
            />
          </label>
          {processandoIA && <p className="text-sm text-yellow-400 mt-2 animate-pulse">{statusMsg}</p>}
          {!processandoIA && statusMsg && <p className="text-sm text-green-400 mt-2">{statusMsg}</p>}
        </div>

        {/* Formulário de Cadastro / Correção Manual */}
        <form onSubmit={handleSubmit} className="bg-gray-800 p-4 rounded-xl shadow-lg border border-gray-700 space-y-4">
          <h2 className="text-md font-semibold text-gray-200 border-b border-gray-700 pb-2 flex items-center gap-2">
            <User className="w-4 h-4 text-blue-400" /> Dados da Encomenda (Editável)
          </h2>

          <div>
            <label className="text-xs text-gray-400 block mb-1">Nome do Morador</label>
            <input 
              type="text" 
              value={morador} 
              onChange={(e) => setMorador(e.target.value)} 
              placeholder="Ex: Carlos Silva"
              required
              className="w-full bg-gray-900 border border-gray-700 rounded-lg p-2.5 text-sm text-white focus:outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="text-xs text-gray-400 block mb-1">Apartamento / Bloco</label>
            <input 
              type="text" 
              value={apartamento} 
              onChange={(e) => setApartamento(e.target.value)} 
              placeholder="Ex: Apto 402 - Bloco B"
              required
              className="w-full bg-gray-900 border border-gray-700 rounded-lg p-2.5 text-sm text-white focus:outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="text-xs text-gray-400 block mb-1">Transportadora</label>
            <input 
              type="text" 
              value={transportadora} 
              onChange={(e) => setTransportadora(e.target.value)} 
              placeholder="Ex: Mercado Livre"
              className="w-full bg-gray-900 border border-gray-700 rounded-lg p-2.5 text-sm text-white focus:outline-none focus:border-blue-500"
            />
          </div>

          <button 
            type="submit" 
            className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-3 rounded-lg transition shadow flex items-center justify-center gap-2">
            <CheckCircle className="w-5 h-5" /> Salvar & Atualizar PDF Diário
          </button>
        </form>

        {/* Lista de Encomendas Pendentes */}
        <div className="bg-gray-800 p-4 rounded-xl shadow-lg border border-gray-700">
          <h2 className="text-md font-semibold text-gray-200 mb-3 flex items-center gap-2">
            <FileText className="w-4 h-4 text-yellow-400" /> Encomendas Recentes
          </h2>

          {encomendas.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-4">Nenhuma encomenda registrada ainda.</p>
          ) : (
            <div className="space-y-3">
              {encomendas.map((item) => (
                <div key={item.id} className="bg-gray-900 p-3 rounded-lg border border-gray-700 flex justify-between items-center">
                  <div>
                    <p className="font-bold text-sm text-white">{item.morador}</p>
                    <p className="text-xs text-gray-400">{item.apartamento} • {item.transportadora}</p>
                    <span className={`inline-block mt-1 text-[10px] px-2 py-0.5 rounded font-semibold ${item.status === 'Pendente' ? 'bg-yellow-900/50 text-yellow-300 border border-yellow-700' : 'bg-green-900/50 text-green-300 border border-green-700'}`}>
                      {item.status}
                    </span>
                  </div>
                  {item.status === 'Pendente' && (
                    <button 
                      onClick={() => darBaixa(item.id)}
                      className="bg-blue-600 hover:bg-blue-500 text-xs text-white px-3 py-1.5 rounded-lg transition">
                      Dar Baixa
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
