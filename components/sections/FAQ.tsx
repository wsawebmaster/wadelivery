import { GradientText } from '@/components/ui/GradientText'
import { Reveal } from './Reveal'

const faqs = [
  {
    question: 'Preciso saber programar para usar a plataforma?',
    answer: 'Não. Todo o processo é visual: você cadastra produtos, preços e fotos pelo painel. O cardápio digital e a loja entram no ar automaticamente.',
  },
  {
    question: 'Realmente não pago comissão por pedido?',
    answer: 'Correto. O pedido entra direto no seu painel, sem taxa por venda. Você paga apenas pelo plano, sem surpresas no fim do mês.',
  },
  {
    question: 'Posso manter minhas lojas no iFood/WhatsApp em paralelo?',
    answer: 'Pode. Muitas empresas usam a plataforma como canal principal e mantêm os outros como complementares. O cardápio é totalmente seu.',
  },
  {
    question: 'Como meu cliente acompanha o pedido?',
    answer: 'Pelo próprio cardápio digital: o status é atualizado em tempo real e o cliente vê cada etapa até a entrega. Sem ligar para a loja.',
  },
]

export function FAQ() {
  return (
    <section className="section" id="faq">
      <div className="container container-narrow">
        <Reveal className="section-head">
          <span className="eyebrow">Dúvidas frequentes</span>
          <h2>Perguntas <GradientText>frequentes</GradientText></h2>
        </Reveal>

        <Reveal className="faq">
          {faqs.map((faq, i) => (
            <details key={i} className="faq-item">
              <summary>{faq.question}</summary>
              <p>{faq.answer}</p>
            </details>
          ))}
        </Reveal>
      </div>
    </section>
  )
}
