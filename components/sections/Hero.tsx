import { GradientText } from '@/components/ui/GradientText'
import { Button } from '@/components/ui/Button'
import { Reveal } from './Reveal'
import { CountUp } from './CountUp'
import { PhoneMockup } from './PhoneMockup'

interface HeroProps {
  onOpenLead: () => void
}

export function Hero({ onOpenLead }: HeroProps) {
  return (
    <section className="hero" id="inicio">
      <div className="container hero-grid">
        <div className="hero-content reveal">
          <div className="hero-badge">
            <span className="pulse-dot" />
            Plataforma para quem faz delivery
          </div>

          <h1>
            Seu delivery <GradientText>próprio</GradientText>, sem comissão e com controle total
          </h1>

          <p className="hero-sub">
            Cardápio digital no seu nome, pedidos em tempo real e um painel completo de gestão.
            Você deixa de pagar taxas abusivas e passa a mandar nos seus dados, preços e clientes.
          </p>

          <div className="hero-actions">
            <Button size="lg" onClick={onOpenLead}>
              Experimentar gratuitamente
              <span className="btn-arrow" aria-hidden="true">&#8594;</span>
            </Button>
            <a href="#solucoes" className="btn btn-ghost btn-lg">Ver soluções</a>
          </div>

          <ul className="hero-trust">
            <li>
              <span className="trust-num" data-count="0"><CountUp target={0} /></span>
              <span className="trust-unit">%</span>
              <span className="trust-label">comissão por pedido</span>
            </li>
            <li>
              <CountUp target={2} />
              <span className="trust-label">min para você no ar</span>
            </li>
            <li>
              <CountUp target={1} suffix="&#215;" />
              <span className="trust-label">dono dos seus dados</span>
            </li>
          </ul>
        </div>

        <Reveal delay={150} className="hero-visual">
          <PhoneMockup />
          <div className="float-card float-card-a reveal" data-reveal-delay="350">
            <span className="float-icon">&#128274;</span>
            <div><strong>Novo pedido</strong><small>#1042 — R$ 49,90</small></div>
          </div>
          <div className="float-card float-card-b reveal" data-reveal-delay="500">
            <span className="float-icon">&#128176;</span>
            <div><strong>0% comissão</strong><small>Você fica com tudo</small></div>
          </div>
        </Reveal>
      </div>

      <div className="hero-scroll" aria-hidden="true"><span /></div>
    </section>
  )
}
