/** REST katmanının HTTP koduna çevirebildiği hata tipi (döngüsel import'u önlemek for ayrı dosyada). */
export class PanelError extends Error {
  constructor(
    message: string,
    public readonly httpStatus = 400
  ) {
    super(message);
  }
}
