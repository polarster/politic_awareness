import { data } from "../data";
import { IMPORTANT_WEIGHT } from "../lib/scoring";

export function Methodology({ onClose }: { onClose: () => void }) {
  return (
    <section className="card prose">
      <span className="eyebrow">方法論</span>
      <h2>計算方法與資料來源</h2>

      <h3>這是什麼</h3>
      <p>
        這是一個幫助你認識自己政治傾向的工具，不是投票建議。我們不會告訴你該支持誰，也不評論哪個立場比較好。
      </p>

      <h3>題目與維度</h3>
      <p>
        全國層的題目採同意量表（-2 非常不同意到 +2 非常同意，另有「不知道 / 無意見」，不計分）。
        每題對應一個維度與方向。標記「這題對我很重要」的題目權重 ×{IMPORTANT_WEIGHT}。
        少數題目（例如核電、國會改革）在維度上方向不明確，只用於逐題對照。
      </p>
      <p>
        市政層以預算分配為主：每個項目從「維持現況」出發，可以增減，最後餘額必須 ≥ 0。
        第一版使用點數，不代表實際金額。
      </p>

      <h3>維度位置</h3>
      <p>各維度位置是該維度內「作答 × 題目方向」的加權平均，範圍 -2 到 +2。全國層與市政層分開計算。</p>

      <h3>契合度</h3>
      <p>
        每題一致度 = 1 − |你的作答 − 對象立場| ÷ 4；預算項目只比較方向（增、減、不變）。
        只計算雙方都有資料的題目，依重要度加權平均，並顯示比對題數。
      </p>

      <h3>立場資料與證據等級</h3>
      <ul>
        <li><strong>A</strong>：記名表決紀錄（立法院、市議會）</li>
        <li><strong>B</strong>：提案、連署、質詢紀錄</li>
        <li><strong>C</strong>：政見、黨綱、聲明、公開發言、訪談、辯論、社群訪談</li>
        <li>查無資料的題目不列入計算，也不推測。</li>
      </ul>
      <p>每個立場都附出處連結，並分開呈現「原文」與「我們的判斷依據」。發現錯誤歡迎回報。</p>
      <p>
        A 級證據來自立法院議事錄的記名表決名單，我們依立法院委員資料比對黨籍後統計各黨投票。
        完整紀錄可在<a href="#/votes">立院投票紀錄</a>查閱。
      </p>

      <h3>隱私</h3>
      <p>
        所有計算都在你的瀏覽器中完成，不需要帳號。只有在你勾選「匿名提供作答」或使用 Claude 對答時，資料才會離開你的裝置。
        對答內容不會被記錄。
      </p>

      <h3>黨徽圖檔來源</h3>
      <p className="small">
        黨徽只用來在圖上辨識政黨，不代表任何政黨背書本網站。圖檔主要取自 Wikimedia Commons：
      </p>
      <ul className="small">
        {data.entities.filter((e) => e.logo).map((e) => (
          <li key={e.id}>
            {e.name}：{e.logo_source ? <><a href={e.logo_source} target="_blank" rel="noreferrer">Commons 檔案頁</a>，</> : ""}
            {e.logo_license}{e.logo_author ? `，作者／來源：${e.logo_author}` : ""}
          </li>
        ))}
      </ul>
      <p className="small muted">沒有可用黨徽圖檔的政黨，以代表色圓徽加一個字表示。</p>

      <button onClick={onClose}>返回</button>
    </section>
  );
}
