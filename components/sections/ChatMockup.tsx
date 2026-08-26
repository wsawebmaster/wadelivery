export function ChatMockup() {
  return (
    <div
      className="chat-mockup"
      role="img"
      aria-label="Exemplo de conversa automática: cliente chama no WhatsApp, recebe o link do cardápio, o pedido é confirmado com frete calculado e o status muda para saiu para entrega"
    >
      <div className="chat-header" aria-hidden="true">
        <span className="chat-avatar">&#x1F354;</span>
        <div className="chat-title">
          <strong>Burger House</strong>
          <small>online</small>
        </div>
        <span className="chat-badge">WhatsApp</span>
      </div>

      <div className="chat-body" aria-hidden="true">
        <div className="chat-bubble out">
          Oi! Quero fazer um pedido &#128242;
          <span className="chat-time">19:02</span>
        </div>
        <div className="chat-bubble in">
          Olá! &#128075; Monte seu pedido no nosso cardápio digital: &nbsp;
          <a href="#automacao" tabIndex={-1} onClick={(e) => e.preventDefault()}>
            wadelivery.com.br/burgerhouse
          </a>
          <span className="chat-time">19:02 &#10003;&#10003;</span>
        </div>
        <div className="chat-bubble out">
          Pedido feito! Smash Duplo + Batata Cheddar + refri
          <span className="chat-time">19:08</span>
        </div>
        <div className="chat-bubble in chat-confirm">
          <strong>Pedido #1042 confirmado &#9989;</strong>
          <small>Entrega: R$ 6,90 (calculada pelo CEP) &#183; Total: R$ 55,70</small>
          <small>Previsão: 30–40 min &#183; Impressão enviada para a cozinha &#128424;</small>
          <span className="chat-time">19:09</span>
        </div>
        <div className="chat-status">&#128295; Em produção</div>
        <div className="chat-status chat-status-go">&#128666; Saiu para entrega</div>
      </div>
    </div>
  )
}
