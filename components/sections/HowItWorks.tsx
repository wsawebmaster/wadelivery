import { GradientText } from '@/components/ui/GradientText'
import { Reveal } from './Reveal'

const steps = [
  {
    num: '01',
    title: 'Crie sua conta',
    description: 'Cadastre-se gratuitamente com nome, e-mail e telefone. Leva menos de 2 minutos.',
  },
  {
    num: '02',
    title: 'Monte seu cardápio',
    description: 'Adicione categorias, produtos, fotos e preços pelo painel. Ajuste quando quiser, sem limite.',
  },
  {
    num: '03',
    title: 'Receba pedidos',
    description: 'Seu cardápio digital entra no ar e os pedidos chegam em tempo real. Você acompanha tudo do painel.',
  },
]

export function HowItWorks() {
  return (
    <section className="section section-alt" id="como-funciona">
      <div className="container">
        <Reveal className="section-head">
          <span className="eyebrow">Simples assim</span>
          <h2>Do cadastro ao primeiro pedido em <GradientText>3 passos</GradientText></h2>
          <p>Você não precisa de equipe técnica nem conhecimento de programação.</p>
        </Reveal>

        <div className="steps">
          {steps.map((step, i) => (
            <Reveal key={i} delay={i * 120}>
              <article className="step">
                <span className="step-num">{step.num}</span>
                <h3>{step.title}</h3>
                <p>{step.description}</p>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}
