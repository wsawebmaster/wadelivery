ARG BUILD_CONFIGURATION=Release
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
ARG BUILD_CONFIGURATION
WORKDIR /src
COPY services/catalog-api/Catalog.Api.csproj services/catalog-api/
RUN dotnet restore services/catalog-api/Catalog.Api.csproj
COPY services/catalog-api/ services/catalog-api/
COPY data/ data/
WORKDIR /src/services/catalog-api
RUN dotnet publish -c $BUILD_CONFIGURATION -o /app/publish /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=build /app/publish .
COPY --from=build /src/data /app/data
ENV ASPNETCORE_URLS=http://+:8080
ENV Data__Root=/app/data
EXPOSE 8080
ENTRYPOINT ["dotnet", "Catalog.Api.dll"]
