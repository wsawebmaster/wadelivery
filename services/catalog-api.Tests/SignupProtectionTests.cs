using System.Net;
using Catalog.Api.Services;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

namespace Catalog.Api.Tests;

public class SignupProtectionTests
{
    private static IConfiguration Config(params (string Key, string? Value)[] values) =>
        new ConfigurationBuilder().AddInMemoryCollection(values.Select(v => new KeyValuePair<string, string?>(v.Key, v.Value))).Build();

    private sealed class FakeDns(Func<string, (HttpStatusCode, string)> answer) : HttpMessageHandler
    {
        public int Calls;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Calls++;
            var (status, body) = answer(request.RequestUri!.Query);
            return Task.FromResult(new HttpResponseMessage(status) { Content = new StringContent(body) });
        }
    }

    private sealed class Factory(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
    }

    private static EmailDomainValidator Validator(HttpMessageHandler handler, IConfiguration? config = null) =>
        new(new Factory(handler), new MemoryCache(new MemoryCacheOptions()), config ?? Config(), NullLogger<EmailDomainValidator>.Instance);

    [Theory]
    [InlineData("joao@example.com")]
    [InlineData("joao@loja.test")]
    [InlineData("joao@localhost")]
    [InlineData("joao@semponto")]
    public void Reserved_or_invalid_domains_are_rejected(string email)
    {
        Assert.NotNull(EmailDomainValidator.ValidateOffline(email, out _));
    }

    [Theory]
    [InlineData("a@mailinator.com")]
    [InlineData("a@yopmail.com")]
    [InlineData("a@sub.guerrillamail.com")]
    public void Disposable_domains_are_rejected(string email)
    {
        Assert.Equal(EmailDomainValidator.DisposableMessage, EmailDomainValidator.ValidateOffline(email, out _));
    }

    [Fact]
    public async Task Domain_with_mx_is_accepted_and_cached()
    {
        var dns = new FakeDns(_ => (HttpStatusCode.OK, """{"Status":0,"Answer":[{"type":15,"data":"10 mx.gmail.com."}]}"""));
        var validator = Validator(dns);
        Assert.Null(await validator.ValidateAsync("dono@gmail.com", default));
        Assert.Null(await validator.ValidateAsync("outro@gmail.com", default));
        Assert.Equal(1, dns.Calls);
    }

    [Fact]
    public async Task Nonexistent_domain_is_rejected()
    {
        var dns = new FakeDns(_ => (HttpStatusCode.OK, """{"Status":3}"""));
        Assert.Equal(EmailDomainValidator.InvalidDomainMessage,
            await Validator(dns).ValidateAsync("dono@dominio-que-nao-existe-123.com.br", default));
    }

    [Fact]
    public async Task Domain_without_mx_falls_back_to_a_record()
    {
        var dns = new FakeDns(q => q.Contains("type=MX")
            ? (HttpStatusCode.OK, """{"Status":0}""")
            : (HttpStatusCode.OK, """{"Status":0,"Answer":[{"type":1,"data":"1.2.3.4"}]}"""));
        Assert.Null(await Validator(dns).ValidateAsync("dono@empresa.com.br", default));
    }

    [Fact]
    public async Task Dns_failure_does_not_block_signup()
    {
        var dns = new FakeDns(_ => (HttpStatusCode.BadGateway, ""));
        Assert.Null(await Validator(dns).ValidateAsync("dono@empresa.com.br", default));
    }

    [Fact]
    public void Ip_hash_is_salted_stable_and_not_the_ip()
    {
        var a = SignupGuardService.HashIp("203.0.113.7", Config(("Security:SignupIpSalt", "sal-1")));
        var b = SignupGuardService.HashIp("203.0.113.7", Config(("Security:SignupIpSalt", "sal-1")));
        var c = SignupGuardService.HashIp("203.0.113.7", Config(("Security:SignupIpSalt", "sal-2")));
        Assert.Equal(a, b);
        Assert.NotEqual(a, c);
        Assert.DoesNotContain("203.0.113.7", a);
        Assert.Equal(64, a!.Length);
        Assert.Null(SignupGuardService.HashIp(null, Config()));
    }

    [Fact]
    public async Task Captcha_is_mandatory_unless_explicitly_allowed()
    {
        var factory = new Factory(new FakeDns(_ => (HttpStatusCode.OK, "{}")));
        var off = new CaptchaValidationService(Config(("Captcha:Enabled", "false")), factory, NullLogger<CaptchaValidationService>.Instance);
        Assert.False(off.IsAvailable);
        Assert.False(await off.ValidateAsync(null, null, default));

        var dev = new CaptchaValidationService(Config(("Captcha:Enabled", "false"), ("Captcha:AllowDisabled", "true")), factory, NullLogger<CaptchaValidationService>.Instance);
        Assert.True(dev.IsAvailable);
        Assert.True(await dev.ValidateAsync(null, null, default));

        var noSecret = new CaptchaValidationService(Config(("Captcha:Enabled", "true")), factory, NullLogger<CaptchaValidationService>.Instance);
        Assert.False(noSecret.IsAvailable);
    }
}
