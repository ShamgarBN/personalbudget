export default function Placeholder({
  name,
  blurb,
}: {
  name: string;
  blurb: string;
}) {
  return (
    <div className="p-8">
      <h1 className="text-2xl font-semibold">{name}</h1>
      <p className="mt-3 text-sm text-gray-600 max-w-prose">{blurb}</p>
    </div>
  );
}
