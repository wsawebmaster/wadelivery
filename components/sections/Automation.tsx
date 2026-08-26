import { GradientText } from '@/components/ui/GradientText'
import { Button } from '@/components/ui/Button'
import { Reveal } from './Reveal'
import { ChatMockup } from './ChatMockup'

interface AutomationProps {
  onOpenLead: () => void
}

export function Automation({ onOpenLead }: AutomationProps) {
  return (
    <section className="section section-alt" id="automacao">
      <div className="container">
        <Reveal className="section-head">
          <span className="eyebrow">Automação</span>
          <h2>Chega de perder tempo anotando pedidos <GradientText>à mão!</GradientText></h2>
          <p>Atendimento mais rápido e organizado — do primeiro &ldquo;oi&rdquo; no WhatsApp ao pedido impresso na cozinha.</p>
        </Reveal>

        <div className="auto-grid">
          <ul className="auto-checklist reveal">
            <li>O cliente chama no WhatsApp e recebe automaticamente o link do seu cardápio digital</li>
            <li>Escolhe os produtos, informa endereço e forma de pagamento montando o pedido em poucos toques</li>
            <li>A taxa de entrega é calculada automaticamente pelo endereço</li>
            <li>O pedido chega completo no seu computador ou celular</li>
            <li>Ao confirmar, a impressão do pedido é disparada automaticamente</li>
            <li>O cliente acompanha a mudança de status no Cardápio Digital</li>
            <li>Na próxima visita, o cardápio pergunta se deseja repetir o último pedido — sem preencher tudo novamente</li>
            <li>Delivery próprio, sem comissão de marketplace</li>
          </ul>

          <Reveal delay={150}>
            <ChatMockup />
          </Reveal>
        </div>

        <Reveal className="auto-footer">
          <p>Menos mensagens para responder, menos erros nos pedidos e muito mais agilidade.</p>
          <Button size="lg" onClick={onOpenLead}>
            &#128640; Automatize os pedidos do seu delivery
            <span className="btn-arrow" aria-hidden="true">&#8594;</span>
          </Button>
        </Reveal>
      </div>
    </section>
  )
}
