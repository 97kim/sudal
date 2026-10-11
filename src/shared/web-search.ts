/** 인앱 브라우저의 검색 주소. 주소창에 주소가 아닌 글을 쓰거나, 선택한 글자를 검색할 때 쓴다. */
export function webSearchUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}
