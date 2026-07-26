import type { ChapterSummary } from "../api/jobs";
import { useLanguageStore } from "../stores/language_store";

export const CREATE_NEW_CHAPTER_VALUE = "__create_new_chapter__";

export function resolveSelectedChapter(
  selectedValue: string,
  chapters: ChapterSummary[]
): ChapterSummary | null {
  return chapters.find((entry) => entry.chapterId === selectedValue) || null;
}

type ChapterSelectorProps = {
  label: string;
  helpText?: string;
  selectedValue: string;
  chapters: ChapterSummary[];
  newChapterTitle: string;
  disabled?: boolean;
  onSelectionChange: (value: string) => void;
  onNewChapterTitleChange: (value: string) => void;
};

export function ChapterSelector({
  label,
  helpText,
  selectedValue,
  chapters,
  newChapterTitle,
  disabled = false,
  onSelectionChange,
  onNewChapterTitleChange,
}: ChapterSelectorProps) {
  const t = useLanguageStore((state) => state.t);
  const sortedChapters = chapters.slice().sort((left, right) => left.sortOrder - right.sortOrder);

  return (
    <label>
      <span>{label}</span>
      {helpText ? <small className="muted-text">{helpText}</small> : null}
      <div className="stacked-field-row">
        <select
          value={selectedValue}
          onChange={(event) => onSelectionChange(event.currentTarget.value)}
          disabled={disabled}
        >
          <option value="">{disabled ? t("selector.chapter.chooseFirst") : t("selector.chapter.select")}</option>
          {sortedChapters.map((chapter) => (
            <option key={chapter.chapterId} value={chapter.chapterId}>
              {chapter.chapterTitle || chapter.chapterId}
            </option>
          ))}
          <option value={CREATE_NEW_CHAPTER_VALUE}>{t("selector.chapter.create")}</option>
        </select>
        {selectedValue === CREATE_NEW_CHAPTER_VALUE ? (
          <input
            placeholder={t("selector.chapter.placeholder")}
            value={newChapterTitle}
            onChange={(event) => onNewChapterTitleChange(event.currentTarget.value)}
          />
        ) : null}
      </div>
    </label>
  );
}
