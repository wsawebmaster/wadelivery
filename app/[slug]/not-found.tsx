export default function NotFound() {
  return (
    <div style={{ padding: '100px 24px', textAlign: 'center' }}>
      <h1 style={{ fontSize: '48px', marginBottom: '16px' }}>404</h1>
      <p style={{ color: 'var(--text-muted)', fontSize: '18px', marginBottom: '24px' }}>
        Cardápio não encontrado. Verifique o link e tente novamente.
      </p>
      <a
        href="/"
        className="btn btn-primary btn-lg"
        style={{ display: 'inline-flex' }}
      >
        Voltar para a página inicial
      </a>
    </div>
  )
}
