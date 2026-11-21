FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY services/orders-api/Orders.Api.csproj services/orders-api/
RUN dotnet restore services/orders-api/Orders.Api.csproj
COPY services/orders-api/ services/orders-api/
WORKDIR /src/services/orders-api
RUN dotnet publish -c Release -o /app/publish /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=build /app/publish .
ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080
ENTRYPOINT ["dotnet", "Orders.Api.dll"]
