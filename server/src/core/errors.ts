/** REST katmanının HTTP koduna çevirebildiği hata tipi (döngüsel import'u önlemek için ayrı dosyada). */
export class PanelError extends Error {
  constructor(
    message: string,
    public readonly httpStatus = 400
  ) {
    super(message);
  }
}
